// The designer's own run ("Start simulation" without leaving the model): started from the
// Run dialog, followed in the designer's bottom dock, and its result bundle kept here. A design's
// runs stay in Design mode (#51): the navigation tree lists them and selecting one shows it in place
// (src/designer/runResults.ts). The third mode, Examples, is for the example projects.
import { createEffect, createRoot, createSignal, on } from "solid-js";
import type { Bundle } from "../types";
import { projectUrl } from "../env";
import { validateBundle, summarize } from "../lib/validate";
import { runQuality } from "../lib/runQuality";
import { appMode, setAppMode } from "../workspace";
import { isTerminal, type Job } from "./api";
import { checks, conflict, dirty, file as designFile, quickPreview, save, schedulePreview } from "../designer/store";
import { bundle, clearProject, lastProject, loadIndex, loadProject, openCount, source } from "../state";
import { newestResults } from "./resultsIndex";
import { requireDesignResult, ResultFollow } from "./resultFollow";
import { exampleEntries } from "./examples";
import { attach, invalidatePreview, jobs, live, meshSource, models, notice, refreshModels, refreshRuns, runName, runOpen, selectModel, serverActivity, setEngine, setNotice, setRunName, setThreads, startRun } from "./store";

import { designDockTab, setDesignDockTab } from "../designer/dockState";
import { t } from "../i18n/index.ts";
import { meshStats } from "../designer/meshStats";
export { designDockTab, setDesignDockTab, type DesignDockTab } from "../designer/dockState";
export const [runDialogOpen, setRunDialogOpen] = createSignal(false);
export const [optimizeDialogOpen, setOptimizeDialogOpen] = createSignal(false);
export const [sweepDialogOpen, setSweepDialogOpen] = createSignal(false);
/** the designer's Simulation settings dialog (src/designer/SimSettingsDialog.tsx) */
export const [simSettingsOpen, setSimSettingsOpen] = createSignal(false);
/** the section the dialog scrolls to when it opens ("freq", "bounds", "mesh", "monitors", "solver"; "currents",
 * "efficiency" and "fieldplanes" add that monitor when there is none and focus its field) */
export const [simSettingsSection, setSimSettingsSection] = createSignal("freq");
/** Open the Simulation settings at a section from a direct Simulation ribbon entry point. */
export function openSimSettings(section = "freq") {
  setSimSettingsSection(section);
  setSimSettingsOpen(true);
}
/** the job the designer started (the live job may later be another one, from the Run panel) */
export const [designJobId, setDesignJobId] = createSignal<string | null>(null);
/** the finished run's bundle, shown in the dock's result tabs */
export const [designResult, setDesignResult] = createSignal<{ file: string; bundle: Bundle; jobId?: string } | null>(null);
export const [designResultError, setDesignResultError] = createSignal<string | null>(null);
/** The result file whose load failed, so the message can offer Retry. */
export const [failedResultLoad, setFailedResultLoad] = createSignal<{ file: string; jobId?: string } | null>(null);
/** Load the result file that failed to load once more. */
export const retryResultLoad = () => { const f = failedResultLoad(); if (f) void loadDesignResult(f.file, f.jobId); };

/** The live job when it is the designer's run. */
export const designJob = (): Job | null => (live.job && live.job.id === designJobId() ? live.job : null);

/** Show a server run in the designer's dock (its Run tab follows it), whoever started it: a run
 * picked in the dock's Queue tab, or a run of the open design another client started (#7, #8). */
export function followInDesigner(job: Job, reveal = true) {
  if (live.job?.id !== job.id) attach(job);
  setDesignJobId(job.id);
  setDesignResultError(null);
  if (reveal) setDesignDockTab("run");
}

/** The run the dock's Cancel stops (#8): the run the dock shows while it goes on, else the run this
 * window follows, else the server's running run, whoever started it (a terminal, another window, an
 * earlier session). null when nothing runs. */
export const dockCancelTarget = (): Job | null => {
  const own = designJob();
  if (own && !isTerminal(own.status)) return own;
  if (live.job && !isTerminal(live.job.status)) return live.job;
  return serverActivity().other;
};
/** A run of this design is going on this machine's CPU: the solver wants the cores (the 3D view draws
 * at a lower resolution meanwhile, scene/renderBudget.ts). A GPU run does not compete for them. */
export const localCpuRunActive = (): boolean => {
  const job = designJob();
  return !!job && job.status === "running" && (job.engine ?? "cpu") === "cpu";
};

const POINTS_KEY = "fairbeam.designer.points";
export function storedPoints(): number {
  try {
    const n = Number(localStorage.getItem(POINTS_KEY));
    if (Number.isInteger(n) && n >= 11 && n <= 20001) return n;
  } catch {
    /* ignore */
  }
  return 801;
}

/** Submit the saved design (the caller has saved and checked it) with these settings. */
export async function startDesignRun(opts: { engine: string; threads: number; points: number; name: string }): Promise<Job | null> {
  setEngine(opts.engine);
  // GPU uses one solver thread; it must not replace the user's remembered CPU choice.
  if (opts.engine !== "gpu") setThreads(opts.threads);
  // the draft's mesh (the server's Auto threads follow it), not a run's results shown in the 3D view
  const nodes = meshStats(meshSource())?.nodes;
  try {
    localStorage.setItem(POINTS_KEY, String(opts.points));
  } catch {
    /* ignore */
  }
  // the run name is shared with the Run panel's form: set it for this submit only
  const before = runName();
  setRunName(opts.name);
  let job: Job | null;
  try {
    job = await startRun({ ...(opts.points !== 801 ? { points: opts.points } : {}), ...(nodes ? { cells: nodes } : {}) });
  } finally {
    setRunName(before);
  }
  if (job) {
    setDesignJobId(job.id);
    setDesignResultError(null);
    setDesignDockTab("run");
  }
  return job;
}

/** Prepare the shared optimizer form from the latest saved designer model and values. */
export async function prepareDesignOptimize(): Promise<string | null> {
  const f = designFile();
  if (!f) return t("runner.optimize.noDesign");
  if (dirty() || conflict()) await save();
  if (dirty() || conflict()) return t("runner.optimize.notSaved");
  if (checks().some((c) => c.severity === "error")) return t("runner.optimize.fixErrors");
  await refreshModels();
  if (!models().some((m) => m.key === f.id)) return t("runner.optimize.notAvailable");
  selectModel(f.id, bundle());
  return null;
}

export function attachDesignOptimize(job: Job) {
  setDesignJobId(job.id);
  setDesignResultError(null);
  setDesignDockTab("run");
}

let resultSeq = 0;
const follower = new ResultFollow();
export async function loadDesignResult(file: string, jobId?: string): Promise<boolean> {
  const expectedModel = designFile()?.design.model.id;
  if (!expectedModel) return false;
  const mine = ++resultSeq;
  setDesignResultError(null);
  setFailedResultLoad(null);
  try {
    // one retry after 500 ms: right after a run the dev server can still answer the just-written
    // file with index.html (not JSON); the built app serves it directly
    const read = async () => {
      const r = await fetch(projectUrl(file), { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<unknown>;
    };
    let raw: unknown;
    try { raw = await read(); } catch { await new Promise((ok) => setTimeout(ok, 500)); if (mine !== resultSeq) return false; raw = await read(); }
    const v = validateBundle(raw);
    if (!v.bundle) throw new Error(summarize(v.errors));
    if (mine !== resultSeq) return false;
    requireDesignResult(v.bundle, expectedModel);
    setDesignResult({ file, bundle: v.bundle, jobId });
    // a run that did not converge keeps the dock on its Run tab: that is where the warning is
    // first shown (the result tabs carry it as a banner too), so the dock must not move away
    const stops = runQuality(v.bundle)?.verdict === "not-converged";
    if (designDockTab() === "run" && (!designJob() || isTerminal(designJob()!.status)) && !stops) setDesignDockTab("runs");
    return true;
  } catch (e) {
    if (mine !== resultSeq) return false;
    if (designResult()?.file === file) setDesignResult(null);
    setDesignResultError(t("load.runResultFailed", { file, error: (e as Error).message }));
    setFailedResultLoad({ file, jobId });
    return false;
  }
}

export function clearDesignResult() {
  resultSeq++;
  follower.dismiss();
  setDesignResult(null);
  setDesignResultError(null);
  setFailedResultLoad(null);
  setDesignJobId(null);
  setDesignDockTab("checks");
}

/** Examples mode: keep an open example (or a bundle opened from a file); replace a geometry preview
 * or a run of one of your designs with the last example opened, else the newest one. */
export async function openExamples() {
  setAppMode("results");
  const b = bundle();
  const entries = exampleEntries(await loadIndex());
  if (b && !b.preview && entries.some((p) => p.file === source())) return;
  invalidatePreview();
  clearProject();
  const start = openCount();
  if (openCount() !== start || appMode() !== "results") return;
  const last = lastProject();
  const pick = entries.find((p) => p.file === last && p.simulated) ?? newestResults(entries)[0] ?? entries[0];
  if (pick) await loadProject(pick.file);
}

// Watch the whole history, not only the job currently attached to the SSE stream. A run
// finished in the Run panel or a sweep belongs in this design's dock too.
createRoot(() => {
  createEffect(on(appMode, (mode) => {
    if (mode === "design" && designFile()) { quickPreview(); schedulePreview(0); }
  }));
  // SSE completion refreshes job history; entering a design also picks up external runs.
  createEffect(on(() => designFile()?.id, () => {
    const running = designJob();
    const keepJob = running && !isTerminal(running.status) ? running.id : null;
    clearDesignResult();
    follower.reset();
    if (keepJob) {
      setDesignJobId(keepJob);
      setDesignDockTab("run");
    }
    if (designFile()) void refreshRuns();
  }));
  createEffect(on([jobs, () => designFile()?.id], () => {
    const file = designFile();
    if (!file) return;
    const latest = jobs().filter((j) => j.status === "done" && j.bundle && j.model === file.id && j.kind !== "optimize")
      .sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0))[0];
    const key = latest ? `${latest.id}:${latest.finished}:${latest.bundle}` : "";
    if (!latest) {
      resultSeq++;
      setDesignResult(null);
      follower.reset();
      return;
    }
    const ticket = follower.begin(key);
    if (!ticket) return;
    // the index lists the new bundle for the navigation tree's Results
    void loadIndex();
    void loadDesignResult(latest.bundle!, latest.id).then((success) => follower.finish(ticket, success));
  }));
  // a run of the open design that this window did not start (a terminal, a script, an agent, another
  // window; #7): follow it in the dock like the designer's own run, unless a run is followed already
  // or the open Run panel shows another, finished run in its progress card (that stays on screen).
  // Sweeps and optimizations keep their own dialogs; the dock's Queue tab lists them.
  createEffect(on([jobs, () => designFile()?.id], () => {
    const file = designFile();
    const shown = live.job;
    if (!file || (shown && (!isTerminal(shown.status) || (runOpen() && shown.id !== designJobId())))) return;
    const mine = jobs().filter((j) => j.model === file.id && !isTerminal(j.status) && !j.sweep && j.kind !== "optimize");
    // the list is newest first: the running run, else the next one to start
    const pick = mine.find((j) => j.status === "running") ?? mine[mine.length - 1];
    if (pick) followInDesigner(pick, false);
  }));
  createEffect(on(notice, (n) => {
    if (n?.kind === "run" && n.job.model === designFile()?.id && appMode() === "design") setNotice(null);
  }));
});
