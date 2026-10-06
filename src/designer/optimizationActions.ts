// What the navigation tree and the Properties panel do with an optimization record.
// The records are the run server's job records (stats carry the evaluations, the best point and the
// manifest file), so nothing new is stored and the .design.json format does not change.
import { api, isTerminal, type Job } from "../runner/api";
import { attach, refreshRuns } from "../runner/store";
import { attachDesignOptimize } from "../runner/designRun";
import { projectUrl } from "../env";
import { draft, edit } from "./store";
import { bestParameterChanges, type OptimizationRun } from "./optimizationResults";
import { t } from "../i18n";

/** Show the job in the dock (its progress chart and evaluations table). */
export function openOptimization(job: Job) {
  attach(job);
  attachDesignOptimize(job);
}

type Manifest = { best?: { params?: Record<string, number> }; evaluations?: { index: number; file?: string | null; params?: Record<string, number>; met?: boolean }[] };

async function readManifest(file: string): Promise<Manifest> {
  const response = await fetch(projectUrl(file), { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as Manifest;
}

/** The evaluated runs in a manifest that have a bundle, in evaluation order. */
export async function loadOptimizationRuns(file: string): Promise<OptimizationRun[]> {
  const doc = await readManifest(file);
  return (doc.evaluations ?? []).flatMap((e) => e.file
    ? [{ index: e.index, file: e.file, met: e.met, label: t("opt.evalLabel", { params: Object.entries(e.params ?? {}).map(([k, v]) => `${k}=${v}`).join(", "), index: e.index }) }]
    : []);
}

/** Apply the best parameters to the open design as one undo step; returns the message to show. */
export async function applyOptimizationBest(job: Job): Promise<string> {
  try {
    const stats = job.stats as { best_params?: Record<string, number> | null; manifest_file?: string; file?: string };
    let values = stats.best_params ?? undefined;
    const file = stats.manifest_file ?? stats.file;
    if (!values && file) values = (await readManifest(file)).best?.params;
    const checked = bestParameterChanges(draft, values ?? {});
    if (!checked.ok) return checked.error;
    edit((d) => {
      for (const [key, value] of Object.entries(checked.changes)) {
        const p = d.params.find((item) => item.key === key)!;
        p.default = value;
        delete p.expr;
      }
    }, "", t("tree.history.applyOptimization"));
    return t("tree.note.applied");
  } catch (error) {
    return t("tree.note.applyFailed", { error: (error as Error).message });
  }
}

export async function stopOptimization(job: Job): Promise<string> {
  try {
    await api.cancel(job.id);
    await refreshRuns();
    return "";
  } catch (error) { return (error as Error).message; }
}

/** Remove the job record (and only that: the evaluated runs stay in the run list). */
export async function deleteOptimizationRecord(job: Job): Promise<string> {
  if (!isTerminal(job.status)) return t("optTree.note.running");
  try {
    await api.deleteRun(job.id, false);
    await refreshRuns();
    return t("optTree.note.deleted");
  } catch (error) { return (error as Error).message; }
}
