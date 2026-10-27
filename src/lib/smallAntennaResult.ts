// Pure export boundary: a snapshot belongs to exactly one displayed result object.
import type { Bundle } from "../types";
import { smallAntennaAnalysis, smallAntennaColumns, type SmallAntennaOptions } from "./smallAntenna.ts";

export type SmallAntennaAnalysis = ReturnType<typeof smallAntennaAnalysis>;
export interface SmallAntennaSnapshot {
  readonly bundle: Bundle;
  readonly file: string;
  readonly selection: "default" | "current";
  readonly analysis: SmallAntennaAnalysis;
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

export function snapshotSmallAntenna(bundle: Bundle, file = "", options?: SmallAntennaOptions,
  analysis = smallAntennaAnalysis(bundle, options)): SmallAntennaSnapshot {
  return Object.freeze({ bundle, file, selection: options ? "current" as const : "default" as const,
    analysis: freezeTree(structuredClone(analysis)) });
}

export class SmallAntennaSnapshotError extends Error {
  constructor() { super("The small-antenna snapshot does not belong to this displayed result."); }
}

export function smallAntennaSnapshotFor(bundle: Bundle, snapshots?: readonly SmallAntennaSnapshot[], file?: string): SmallAntennaSnapshot {
  if (snapshots === undefined) return snapshotSmallAntenna(bundle, file);
  const matches = snapshots.filter(snapshot => snapshot.bundle === bundle && (file === undefined || snapshot.file === file));
  if (matches.length !== 1) throw new SmallAntennaSnapshotError();
  return matches[0];
}

export function smallAntennaResultColumns(bundle: Bundle, snapshots?: readonly SmallAntennaSnapshot[], file?: string) {
  const snapshot = smallAntennaSnapshotFor(bundle, snapshots, file), columns = smallAntennaColumns(snapshot.analysis);
  return { header: [...columns.header, "Small antenna selection", "Small antenna result file"],
    row: [...columns.row, snapshot.selection, snapshot.file] };
}
