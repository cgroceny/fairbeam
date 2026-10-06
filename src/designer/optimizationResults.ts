import type { Job } from "../runner/api";
import type { NavNode } from "./navModel";
import type { Design } from "./types";
import { t } from "../i18n/index.ts";
import { goalText } from "../runner/optimizeGoals.ts";

type OptStats = Job["stats"] & {
  file?: string; manifest_file?: string; best_file?: string; best_params?: Record<string, number>;
  evaluations?: number; max_evals?: number; best_cost?: number; reason?: string;
};
const stats = (job: Job) => job.stats as OptStats;
export const isOptimizationJob = (job: Job) => job.kind === "optimize" || !!job.optimize;

/** One evaluated run of an optimization (from its manifest, or the live events). */
export interface OptimizationRun { index: number; file: string; label: string; met?: boolean }

const METHODS: Record<string, string> = {
  auto: "optTree.method.auto", secant: "optTree.method.secant", "nelder-mead": "optTree.method.nelderMead", bayesian: "optTree.method.bayesian",
  "cma-es": "optTree.method.cmaEs", "particle-swarm": "optTree.method.particleSwarm", genetic: "optTree.method.genetic", "trust-region": "optTree.method.trustRegion",
};
export const methodName = (m: string | undefined) => (m && METHODS[m] ? t(METHODS[m]) : m || t("optTree.method.auto"));

/** "Nelder–Mead · |S11| ≤ -10 dB @ 2.45 GHz · 14/40 · running" */
export function optimizationLabel(job: Job): string {
  const goals = job.optimize?.goals ?? [];
  const goal = goals.length ? goalText(goals[0]) + (goals.length > 1 ? ` +${goals.length - 1}` : "") : "";
  const s = stats(job);
  const max = s.max_evals ?? job.optimize?.max_evals;
  const count = `${s.evaluations ?? 0}${max ? `/${max}` : ""}`;
  return [methodName(job.optimize?.method), goal, count, t(`optTree.status.${job.status}`)].filter(Boolean).join(" · ");
}

/** Optimization jobs of the open design, running and finished, newest first. `designId` is the design's
 * file id (the run server's model key, e.g. "my_patch"), which is what a job's `model` holds; the design's
 * `model.id` ("my-patch") may differ. `runs` lists a job's evaluated runs (empty until known). */
export function optimizationNodes(jobs: readonly Job[], designId: string, runs: (jobId: string) => readonly OptimizationRun[] = () => []): NavNode[] {
  if (!designId) return [];
  return jobs.filter((j) => isOptimizationJob(j) && j.model === designId)
    .sort((a, b) => (b.finished ?? b.created) - (a.finished ?? a.created)).map((job) => {
      const s = stats(job), file = s.manifest_file ?? s.file ?? "";
      const best = s.best_file;
      const children: NavNode[] = [{ id: `opt-history:${job.id}`, label: t("optTree.progress"), icon: "curve",
        action: { kind: "optimization-history", jobId: job.id, file } }];
      if (best) children.push({ id: `opt-best:${job.id}`, label: t("optTree.best"), icon: "run",
        action: { kind: "optimization-best", jobId: job.id, file: best } });
      const list = runs(job.id);
      if (list.length) children.push({ id: `opt-runs:${job.id}`, label: t("optTree.runs"), sub: String(list.length), icon: "group", open: false,
        action: { kind: "optimization-history", jobId: job.id, file },
        children: list.map((r) => ({ id: `opt-run:${job.id}:${r.index}`, label: r.label, icon: "run", sub: r.file === best ? t("optTree.bestMark") : undefined,
          action: { kind: "optimization-best", jobId: job.id, file: r.file } })) });
      return { id: `optimization:${job.id}`, label: optimizationLabel(job), title: file || job.id, icon: "group",
        action: { kind: "optimization", jobId: job.id, file }, open: false, children };
    });
}

/** Validate every supplied parameter before applying any of them. */
export function bestParameterChanges(design: Design, values: Record<string, number>): { ok: true; changes: Record<string, number> } | { ok: false; error: string } {
  const params = new Set((design.params ?? []).map((p) => p.key));
  const keys = Object.keys(values);
  if (!keys.length) return { ok: false, error: t("opt.best.none") };
  for (const key of keys) {
    if (!params.has(key)) return { ok: false, error: t("opt.best.unknown", { key }) };
    if (typeof values[key] !== "number" || !Number.isFinite(values[key])) return { ok: false, error: t("opt.best.invalid", { key }) };
    const p = design.params.find((item) => item.key === key)!;
    if (p.min != null && values[key] < p.min || p.max != null && values[key] > p.max)
      return { ok: false, error: t("opt.best.outOfBounds", { key }) };
  }
  return { ok: true, changes: values };
}
