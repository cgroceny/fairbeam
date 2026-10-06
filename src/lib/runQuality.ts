// A run's quality verdict (the UX review: a run that did not converge looked like a good result).
// Pure (no Solid, no DOM), so scripts/check-run-quality.mjs runs it on the example bundles.
//   converged      every port's run reached the energy end criterion and nothing looks unphysical
//   not-converged  a run stopped at the timestep limit: the results are truncated, S11 and the far
//                  field may be wrong
//   suspicious     converged, but a passive antenna shows |S11| above 0 dB or a radiation
//                  efficiency above 100 % (beyond the numerical tolerance): check the mesh, the
//                  boundaries' distance and the end criterion; or the port is not coupled to the
//                  antenna (|S11| stays at about 0 dB over the whole band, or the total
//                  efficiency is a few percent at most): a feed that no longer spans a gap, e.g.
//                  after the geometry was rotated
// Reasons carry codes and numbers only; the UI words them (i18n) and places them.
import type { Bundle, ProjectIndexEntry } from "../types";
import { drivenPort, mismatchAt, radEfficiency } from "./farfieldQuantity.ts";

export type RunVerdict = "converged" | "not-converged" | "suspicious";

export type QualityReason =
  | { code: "timestep-limit"; port?: number }
  | { code: "s11-above-0db"; port: number; db: number; f: number }
  | { code: "efficiency-above-100"; efficiency: number; f: number }
  /** the port is not coupled: |S11| never goes below `s11MinDb` (about 0 dB) over the band and/or the
   * total efficiency (fraction) is `efficiency` at most, in every far-field entry; either may be absent */
  | { code: "port-uncoupled"; port?: number; s11MinDb?: number; efficiency?: number };

export interface RunQuality { verdict: RunVerdict; reasons: QualityReason[] }

/** |S11| above 0 dB by more than this is not a numerical ripple (dB). */
export const S11_TOLERANCE_DB = 0.1;
/** radiation efficiency above 1 by more than this is flagged (the exporter already warns above 1). */
export const EFFICIENCY_TOLERANCE = 0.05;
/** |S11| at or above this over the whole band: the port delivers almost nothing (dB) */
export const UNCOUPLED_S11_DB = -0.5;
/** total efficiency below this in every far-field entry: nothing is radiated (fraction) */
export const UNCOUPLED_EFFICIENCY = 0.02;

/** The largest total efficiency (radiation efficiency x (1 - |S11|^2) of the driven port) over the
 * far-field entries when it is below UNCOUPLED_EFFICIENCY in every one of them, else null (also when
 * an entry's efficiency is unknown: nothing is judged then). */
function uncoupledEfficiency(b: Bundle): number | null {
  let best: number | null = null;
  for (const ff of b.results?.farfield ?? []) {
    const eff = radEfficiency(ff), mis = mismatchAt(b, ff.f, drivenPort(b, ff));
    if (eff === null || mis === null) return null;
    best = Math.max(best ?? -Infinity, eff * mis);
  }
  return best !== null && best < UNCOUPLED_EFFICIENCY ? best : null;
}

/** A converged run whose match is poor: the best |S11| over the band stays above this (dB). */
export const POOR_MATCH_DB = -6;
/** The resonance is "off" the design frequency when it is further from it than this fraction. */
export const OFF_DESIGN_FRACTION = 0.1;

export interface MatchHint {
  /** frequency of the lowest |S11| (Hz) and its level (dB) */
  f: number; db: number;
  /** the design frequency (Hz): the first far-field frequency, else the band centre */
  f0: number;
  /** "below" / "above": the resonance against the design frequency, when it is off by more than OFF_DESIGN_FRACTION */
  off?: "below" | "above";
}

/** A hint for a converged run that works but is not a good antenna yet: |S11| never goes below
 * POOR_MATCH_DB over the band, or the resonance sits well away from the design frequency. Not a
 * verdict (the run is fine); null when nothing is worth saying or the run is not converged. */
export function matchHint(b: Bundle): MatchHint | null {
  const res = b.results;
  const q = runQuality(b);
  if (!res || !b.run || !q || q.verdict === "not-converged") return null;
  const port = Object.values(res.ports ?? {})[0];
  const f = res.frequency ?? [];
  if (!port) return null;
  let best = Infinity, at = 0;
  // a dip at the very edge of the band is the start of a resonance outside it, not the antenna's: look inside
  const n = Math.min(port.s11_re.length, port.s11_im.length, f.length);
  const edge = Math.max(1, Math.floor(n * 0.03));
  for (let i = edge; i < n - edge; i++) {
    const db = 10 * Math.log10(port.s11_re[i] ** 2 + port.s11_im[i] ** 2);
    if (Number.isFinite(db) && db < best) { best = db; at = f[i]; }
  }
  if (!Number.isFinite(best) || !(at > 0)) return null;
  const ex = b.solver?.excitation;
  const f0 = res.farfield?.[0]?.f ?? (ex ? (ex.f_min + ex.f_max) / 2 : 0);
  if (!(f0 > 0)) return null;
  const rel = (at - f0) / f0;
  const off = Math.abs(rel) > OFF_DESIGN_FRACTION ? (rel < 0 ? "below" : "above") : undefined;
  if (best <= POOR_MATCH_DB && !off) return null;
  return { f: at, db: best, f0, ...(off ? { off } : {}) };
}

/** The verdict of a finished run, or null for a bundle without results (a geometry preview). */
export function runQuality(b: Bundle): RunQuality | null {
  const res = b.results;
  if (!res || !b.run) return null;
  const reasons: QualityReason[] = [];
  const portRuns = b.run.port_runs;
  if (portRuns?.length) {
    for (const pr of portRuns) if (!pr.converged) reasons.push({ code: "timestep-limit", port: pr.port });
  } else if (!b.run.converged) {
    reasons.push({ code: "timestep-limit" });
  }
  const f = res.frequency ?? [];
  const uncoupled = new Map<number, { s11MinDb: number }>();   // ports whose |S11| never dips below -0.5 dB
  for (const [key, pr] of Object.entries(res.ports ?? {})) {
    let worst = -Infinity, best = Infinity, at = 0;
    for (let i = 0; i < Math.min(pr.s11_re.length, pr.s11_im.length); i++) {
      const db = 10 * Math.log10(pr.s11_re[i] ** 2 + pr.s11_im[i] ** 2);
      if (Number.isFinite(db) && db > worst) { worst = db; at = f[i] ?? 0; }
      if (Number.isFinite(db) && db < best) best = db;
    }
    if (worst > S11_TOLERANCE_DB) reasons.push({ code: "s11-above-0db", port: Number(key), db: worst, f: at });
    if (Number.isFinite(best) && best >= UNCOUPLED_S11_DB) uncoupled.set(Number(key), { s11MinDb: best });
  }
  for (const ff of res.farfield ?? []) {
    const eta = ff.rad_efficiency;
    if (typeof eta === "number" && Number.isFinite(eta) && eta > 1 + EFFICIENCY_TOLERANCE) {
      reasons.push({ code: "efficiency-above-100", efficiency: eta, f: ff.f });
    }
  }
  const eta = uncoupledEfficiency(b);
  const [first] = [...uncoupled];
  if (first || eta !== null) {
    reasons.push({ code: "port-uncoupled", ...(first ? { port: first[0], s11MinDb: first[1].s11MinDb } : {}), ...(eta !== null ? { efficiency: eta } : {}) });
  }
  const verdict: RunVerdict = reasons.some((r) => r.code === "timestep-limit") ? "not-converged"
    : reasons.length ? "suspicious" : "converged";
  return { verdict, reasons };
}

/** The verdict the project index carries for a run (python/fairbeam/cli.py run_quality, the same
 * rules), so a run can be badged before its bundle is read: the verdict alone, without reasons.
 * Null for an index without the field (older ones) or an entry without results. */
export function indexQuality(entry: Pick<ProjectIndexEntry, "quality"> | undefined): RunQuality | null {
  const verdict = entry?.quality;
  return verdict === "converged" || verdict === "not-converged" || verdict === "suspicious" ? { verdict, reasons: [] } : null;
}
