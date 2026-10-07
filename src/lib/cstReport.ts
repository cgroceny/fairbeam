// The CST import report (python/fairbeam/cst_import.py) as the dialog states it: the summary is
// computed from the rows the report lists, never from a flag of its own, so a report cannot say
// "everything was imported" above rows that say a solid is missing.
import en from "../i18n/en.json" with { type: "json" };
import tr from "../i18n/tr.json" with { type: "json" };
import type { CstImportReport } from "../runner/api.ts";

export type ReportNote = CstImportReport["notes"][number];

/** How a row is labelled: "missing" (fairbeam's own export left it out), "refused" (not imported),
 * "warning" (imported with a change) or "info" (nothing to do). */
export type NoteKind = "missing" | "refused" | "warning" | "info";
export const noteKind = (n: ReportNote): NoteKind => (n.kind === "missing" ? "missing" : n.severity);

/** Prefer server-provided Turkish text, then the translated mesh mapping notes.
 * Other report messages keep their English text. */
export const noteText = (n: ReportNote, lang: string): string => {
  if (lang !== "tr") return n.message;
  if (typeof n.message_tr === "string" && n.message_tr) return n.message_tr;
  for (const key of ["home.importCst.meshHex", "home.importCst.meshIgnored"] as const) {
    if (n.message === en[key]) return tr[key];
  }
  return n.message;
};

/** Identical rows (same severity, place and message) once, with their `count`. The server merges
 * them already; this covers a report from an older server. */
export function mergeNotes(notes: readonly ReportNote[]): ReportNote[] {
  const out: ReportNote[] = [];
  const seen = new Map<string, ReportNote>();
  for (const n of notes) {
    const key = `${n.severity}\u0000${n.where}\u0000${n.message}`;
    const first = seen.get(key);
    if (first) {
      first.count = (first.count ?? 1) + (n.count ?? 1);
      first.lines = [...(first.lines ?? []), ...(n.lines ?? (n.line ? [n.line] : []))];
      continue;
    }
    const copy: ReportNote = { ...n, count: n.count ?? 1, lines: [...(n.lines ?? (n.line ? [n.line] : []))] };
    seen.set(key, copy);
    out.push(copy);
  }
  return out;
}

/** The gaps of an import, one per row: what was left out of the macro, what was not imported and
 * what was imported with a change. `total` 0 is the only case in which "everything was imported". */
export function gapCounts(notes: readonly ReportNote[]): { missing: number; refused: number; changed: number; total: number } {
  let missing = 0, refused = 0, changed = 0;
  for (const n of mergeNotes(notes)) {
    const k = noteKind(n);
    if (k === "missing") missing++;
    else if (k === "refused") refused++;
    else if (k === "warning") changed++;
  }
  return { missing, refused, changed, total: missing + refused + changed };
}

/** Line numbers as ranges: [199, 200, 201, 202] -> [[199, 202]], [4, 9] -> [[4, 4], [9, 9]]. */
export function lineRuns(lines: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const l of [...new Set(lines)].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && l === last[1] + 1) last[1] = l;
    else runs.push([l, l]);
  }
  return runs;
}
