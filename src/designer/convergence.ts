// Mesh convergence study (an adaptive mesh check) in the designer: the densities and tolerances
// of the dialog, the design at another density, the total time estimate and the report rows. Pure
// (no Solid, no DOM), so scripts/check-convergence.mjs tests it. The study itself runs on the server
// (python/fairbeam/convergence.py): one run per density until the changes are below the tolerances.
import type { Design } from "./types";
import { fmt, t } from "../i18n/index.ts";
import { durationText } from "./meshStats.ts";

export const DENSITY_KEY = "mesh.cells_per_wavelength";
export const DEFAULT_DENSITIES = [15, 20, 30, 40];
export const DEFAULT_TOL = { f_pct: 0.5, s11_db: 1, dmax_db: 0.2 };
export const DEFAULT_MAX_RUNS = 4;
export const MAX_DENSITIES = 12;
/** above this total estimate the dialog warns before starting (seconds); the estimate is shown in whole
 * minutes from 10 min on, so the warning needs the shown figure to be above 10 min: it never calls a
 * study long next to an estimate that reads "10 min" */
export const WARN_SECONDS = 600;

export type Tolerances = typeof DEFAULT_TOL;

/** "15, 20, 30, 40" -> numbers, coarse to fine, or the reason they cannot run. */
export function parseDensities(text: string): { values: number[]; error?: string } {
  const parts = text.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const values = parts.map(Number);
  if (values.some((v) => !Number.isFinite(v))) return { values: [], error: t("conv.err.notNumbers") };
  if (values.length < 2) return { values, error: t("conv.err.twoDensities") };
  if (values.length > MAX_DENSITIES) return { values, error: t("conv.err.tooMany", { max: MAX_DENSITIES }) };
  if (values.some((v) => v < 4 || v > 200)) return { values, error: t("conv.err.range") };
  if (values.some((v, i) => i > 0 && v <= values[i - 1])) return { values, error: t("conv.err.order") };
  return { values };
}

/** The densities that may run: the first `maxRuns` of them. */
export function planDensities(values: readonly number[], maxRuns: number): number[] {
  return values.slice(0, Math.max(0, Math.floor(maxRuns)));
}

/** Why the design cannot run a study, or null. */
export function meshBlocker(d: Pick<Design, "mesh">): string | null {
  if (d.mesh?.mode === "manual")
    return t("conv.err.manualMesh");
  return null;
}

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** The design's own density when it is a plain number (null for an expression or the server's choice). */
export function currentDensity(d: Pick<Design, "mesh">): number | null {
  const m = d.mesh ?? {};
  if (m.mode === "manual") return null;
  if (m.mode === "design") return num(m.overrides?.cells_per_wavelength);
  return num(m.cells_per_wavelength ?? 20);
}

/** Set the density in place (the dialog's Apply, and the preview copies): mirrors
 * python/fairbeam/convergence.py with_density. An explicit air density scales with it when both are
 * plain numbers, else it is dropped so the air follows the feature density. */
export function setDensity(d: Design, cpw: number): void {
  if (d.mesh?.mode === "manual") throw new Error(meshBlocker(d) ?? "manual mesh");
  const design = d.mesh.mode === "design";
  const holder = (design ? (d.mesh.overrides ??= {}) : d.mesh) as Record<string, unknown>;
  const old = num(holder.cells_per_wavelength ?? (design ? null : 20));
  holder.cells_per_wavelength = cpw;
  const air = holder.air_cells_per_wavelength;
  if (air !== undefined && air !== null && air !== "") {
    const a = num(air);
    if (a !== null && old) holder.air_cells_per_wavelength = Math.round(Math.min(cpw, (a * cpw) / old) * 1000) / 1000;
    else delete holder.air_cells_per_wavelength;
  }
}

/** A copy of the design at this density (for the preview that estimates the run time). */
export function designAtDensity<T extends Design>(d: T, cpw: number): T {
  const copy = JSON.parse(JSON.stringify(d)) as T;
  setDensity(copy, cpw);
  return copy;
}

/** The whole study's time range from one estimate per density (null when one is unknown). */
export function totalEstimate(each: readonly ({ seconds: [number, number] } | null)[]): [number, number] | null {
  if (!each.length || each.some((e) => !e)) return null;
  return each.reduce<[number, number]>((s, e) => [s[0] + e!.seconds[0], s[1] + e!.seconds[1]], [0, 0]);
}

/** The warning shown before a long study, or null. It quotes the estimate it is based on. */
export function longStudyWarning(total: [number, number] | null): string | null {
  if (!total || Math.round(total[1] / 60) <= WARN_SECONDS / 60) return null;
  return t("conv.longWarning", { max: durationText(total[1]) });
}

// ------------------------------------------------------------------ the study (GET /api/convergence/{id})

export interface ConvergenceMetrics {
  f_res: number | null;
  /** nothing is matched and the |S11| minimum is at a band edge: f_res is where the curve ends, not a
   * resonance (a study file written before this field has none: a resonance is assumed) */
  no_resonance?: boolean;
  s11_db: number | null;
  dmax_dbi: number | null;
  zin_re: number | null;
  zin_im: number | null;
  cells?: number | null;
  wall_time_s?: number | null;
}
export interface ConvergenceStep {
  from: number;
  to: number;
  df_pct: number | null;
  ds11_db: number | null;
  ddmax_db: number | null;
  dzin_ohm: number | null;
  ok: { f: boolean; s11: boolean; dmax: boolean | null };
  /** false when either run has no resonance in the band: the step says nothing and never converges
   * (absent in a study written before this field: comparable) */
  comparable?: boolean;
  converged: boolean;
}
export interface ConvergenceStudy {
  id: string;
  name: string;
  kind: "mesh-convergence";
  members: { density: number; status: string; job?: string; file: string | null; metrics: Partial<ConvergenceMetrics>; error?: string }[];
  convergence: {
    tolerances: Tolerances;
    densities: number[];
    max_runs: number;
    steps: ConvergenceStep[];
    converged: boolean;
    converged_at: number | null;
    done: boolean;
    reason: "converged" | "exhausted" | "failed" | "cancelled" | "running";
    verdict: string;
    next: number | null;
  };
}

export interface ReportRow {
  density: number;
  status: string;
  cells: number | null;
  fGhz: number | null;
  df: number | null;
  s11: number | null;
  ds11: number | null;
  dmax: number | null;
  ddmax: number | null;
  zin: string;
  dz: number | null;
  time: number | null;
  /** this run is compared with the previous one: converged step or not (null for the first run, and
   * for a step that cannot be compared) */
  ok: boolean | null;
  /** the step from the previous run is not comparable: one of the two has no resonance in the band */
  notComparable: boolean;
  /** this run has no resonance in the band (its minimum is at the band edge) */
  noResonance: boolean;
  /** the density the study converged at */
  chosen: boolean;
}

/** One row per run: the values and the change from the previous run. */
export function reportRows(study: ConvergenceStudy): ReportRow[] {
  const conv = study.convergence;
  return study.members.map((m, i) => {
    const x = m.metrics ?? {};
    const st = i > 0 ? conv.steps[i - 1] : undefined;
    const zin = x.zin_re != null && x.zin_im != null ? `${fmt.fixed(x.zin_re, 1)} ${x.zin_im < 0 ? "−" : "+"} j${fmt.fixed(Math.abs(x.zin_im), 1)}` : "—";
    return {
      density: m.density, status: m.status, cells: x.cells ?? null,
      fGhz: x.f_res != null ? x.f_res / 1e9 : null, df: st?.df_pct ?? null,
      s11: x.s11_db ?? null, ds11: st?.ds11_db ?? null,
      dmax: x.dmax_dbi ?? null, ddmax: st?.ddmax_db ?? null,
      zin, dz: st?.dzin_ohm ?? null, time: x.wall_time_s ?? null,
      ok: st && st.comparable !== false ? st.converged : null, notComparable: st?.comparable === false,
      noResonance: x.no_resonance === true, chosen: conv.converged_at === m.density,
    };
  });
}

/** A quantity against the density, for the report's small plots. */
export function series(study: ConvergenceStudy, key: "f_res" | "s11_db" | "dmax_dbi"): { x: number; y: number }[] {
  const div = key === "f_res" ? 1e9 : 1;
  return study.members.flatMap((m) => {
    const v = m.metrics?.[key];
    return typeof v === "number" && Number.isFinite(v) ? [{ x: m.density, y: v / div }] : [];
  });
}

/** Plot geometry for a small line chart: points scaled into a width × height box with padding. */
export function plotPoints(pts: readonly { x: number; y: number }[], w: number, h: number, pad = 6): { x: number; y: number }[] {
  if (!pts.length) return [];
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  if (y1 - y0 < 1e-12) { y0 -= 1; y1 += 1; }
  const sx = (x: number) => (x1 === x0 ? w / 2 : pad + ((x - x0) / (x1 - x0)) * (w - 2 * pad));
  const sy = (y: number) => h - pad - ((y - y0) / (y1 - y0)) * (h - 2 * pad);
  return pts.map((p) => ({ x: sx(p.x), y: sy(p.y) }));
}

/** The server's verdict (python/fairbeam/convergence.py summarize) in the UI language; an unknown
 * one (e.g. "stopped: <error>") is shown as sent. */
export function verdictText(verdict: string): string {
  let m: RegExpMatchArray | null;
  if ((m = verdict.match(/^converged at (.+) cells\/λ$/))) return t("conv.verdict.converged", { density: m[1] });
  if (verdict === "not converged: refine further or check the model") return t("conv.verdict.notConverged");
  if (verdict === "not comparable: no resonance in the band (the minimum is at the band edge)") return t("conv.verdict.notComparable");
  if ((m = verdict.match(/^stopped: the run at (.+) cells\/λ failed$/))) return t("conv.verdict.runFailed", { density: m[1] });
  if (verdict === "stopped before it converged") return t("conv.verdict.cancelled");
  if ((m = verdict.match(/^running: (\d+) of up to (\d+) runs$/))) return t("conv.verdict.running", { n: m[1], max: m[2] });
  return verdict;
}

/** The report's verdict: for a study that ran out of densities it names the quantity that was
 * still moving, with the last two densities and the limit ("Not converged: resonance still moves
 * 0.8 % between 30 and 40 cells/λ (limit 0.5 %)"); every other verdict is `verdictText`. */
export function verdictDetail(study: ConvergenceStudy): string {
  const c = study.convergence;
  const step = c.reason === "exhausted" ? c.steps[c.steps.length - 1] : undefined;
  if (!step) return verdictText(c.verdict);
  // a step with a band-edge "resonance" says nothing about the mesh: do not blame the resonance for moving
  if (step.comparable === false) return t("conv.verdict.notComparableLast", { from: fmt.num(step.from, 3), to: fmt.num(step.to, 3) });
  const at = { from: fmt.num(step.from, 3), to: fmt.num(step.to, 3) };
  const why: string[] = [];
  if (!step.ok.f && step.df_pct != null)
    why.push(t("conv.why.f", { ...at, value: fmt.num(Math.abs(step.df_pct), 2), limit: fmt.num(c.tolerances.f_pct, 4) }));
  if (!step.ok.s11 && step.ds11_db != null)
    why.push(t("conv.why.s11", { ...at, value: fmt.num(Math.abs(step.ds11_db), 2), limit: fmt.num(c.tolerances.s11_db, 4) }));
  if (step.ok.dmax === false && step.ddmax_db != null)
    why.push(t("conv.why.dmax", { ...at, value: fmt.num(Math.abs(step.ddmax_db), 2), limit: fmt.num(c.tolerances.dmax_db, 4) }));
  return why.length ? t("conv.verdict.notConvergedWhy", { why: why.join("; ") }) : verdictText(c.verdict);
}

/** The navigation tree's line for a study folder: "3 of 4 runs · converged at 30 cells/λ". */
export function studySub(meta: { total: number; done: number; failed: number; active: boolean; verdict?: string }, planned?: number): string {
  const runs = t("conv.sub.runs", { done: meta.done, total: planned ?? meta.total });
  if (meta.active) return t("conv.sub.inProgress", { runs });
  if (meta.verdict) return `${runs} · ${verdictText(meta.verdict)}`;
  return meta.failed ? t("conv.sub.failed", { runs }) : t("conv.sub.stopped", { runs });
}
