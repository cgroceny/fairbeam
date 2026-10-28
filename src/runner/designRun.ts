import { openResearch } from "./researchState";
// The designer's own run ("Start simulation" without leaving the model): started from the
// Run dialog, followed in the designer's bottom dock, and its result bundle kept here. A design's
// runs stay in Design mode (#51): the navigation tree lists them and selecting one shows it in place
// (src/designer/runResults.ts). The third mode, Examples, is for the example projects.
import { batch, createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import type { Bundle } from "../types";
import { projectUrl } from "../env";
import { validateBundle, summarize } from "../lib/validate";
import { matchesResultIndex, resultStamp } from "../lib/resultIdentity";
import { runQuality } from "../lib/runQuality";
import { appMode, appModeRevision, setAppMode } from "../workspace";
import { isTerminal, type Job } from "./api";
import { checks, file as designFile, prepareSavedDesign, quickPreview, schedulePreview } from "../designer/store";
import type { SavedDesignTarget } from "../designer/sessionIO";
import { bundle, clearProject, index, lastProject, loadIndex, loadProject, openCount, source, sourceOrigin } from "../state";
import { newestResults } from "./resultsIndex";
import { requireDesignResult, ResultFollow } from "./resultFollow";
import { exampleEntries } from "./examples";
import { attach, invalidatePreview, jobs, live, meshSource, models, notice, refreshModels, refreshRuns, runName, runOpen, selectModel, serverActivity, setEngine, setNotice, setRunName, setThreads, startRun } from "./store";

import { designDockTab, setDesignDockTab, showDesignDockTab } from "../designer/dockState";
import { t } from "../i18n/index.ts";
import { documentJobMatches, documentResultFiles, hasDocumentResultScope, nativeDocumentFor } from "../lib/nativeDocuments";
import { meshStats } from "../designer/meshStats";
export { designDockTab, setDesignDockTab, type DesignDockTab } from "../designer/dockState";
export const [runDialogOpen, setRunDialogOpen] = createSignal(false);
export const [optimizeDialogOpen, setOptimizeDialogOpen] = createSignal(false);
export const [sweepDialogOpen, setSweepDialogOpen] = createSignal(false);
export { simSettingsOpen, setSimSettingsOpen, simSettingsSection, setSimSettingsSection, openSimSettings } from "../designer/simSettingsState";
/** the job the designer started (the live job may later be another one, from the Run panel) */
export const [designJobId, setDesignJobId] = createSignal<string | null>(null);
/** the finished run's bundle, shown in the dock's result tabs */
const [storedDesignResult, setDesignResultSignal] = createSignal<{ file: string; bundle: Bundle; jobId?: string } | null>(null);
export const setDesignResult = setDesignResultSignal;
export const [designResultLoading, setDesignResultLoading] = createSignal<string | null>(null);
export const [designResultError, setDesignResultError] = createSignal<string | null>(null);
/** The result file whose load failed, so the message can offer Retry. */
export const [failedResultLoad, setFailedResultLoad] = createSignal<{ file: string; jobId?: string } | null>(null);
export const designResult = createRoot(() => createMemo(() => {
  const run = storedDesignResult();
  const target = designResultLoading() ?? failedResultLoad()?.file;
  return run && (!target || target === run.file) &&
    (documentResultFiles(designFile(), jobs())?.has(run.file) ?? true) &&
    matchesResultIndex(index().find(entry => entry.file === run.file), run.bundle) ? run : null;
}));
/** A replaced result stays selected while reloading or waiting for an explicit Retry. */
export const pendingDesignResultFile = () => {
  const run = storedDesignResult();
  return designResultLoading() ?? failedResultLoad()?.file ?? (run && !designResult() ? run.file : null);
};
/** Load the result file that failed to load once more. */
export const retryResultLoad = () => { const f = failedResultLoad(); if (f) void loadDesignResult(f.file, f.jobId); };

/** The live job when it is the designer's run. */
export const designJob = (): Job | null => (live.job && live.job.id === designJobId() ? live.job : null);
const belongsToDesign = (job: Job) => {
  const file = designFile();
  return !!file && (hasDocumentResultScope(file) ? documentJobMatches(file, job) : job.model === file.id ||
    (job.research?.backend === "elmer" && job.research.settings.analysis === "driven" && job.model_id === file.design.model.id));
};

/** Show a server run in the designer's dock (its Run tab follows it), whoever started it: a run
 * picked in the dock's Queue tab, or a run of the open design another client started (#7, #8). */
export function followInDesigner(job: Job, reveal = true) {
  if (job.kind === "research" && job.research?.settings.analysis !== "driven") { openResearch(job.id); return; }
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
export async function startDesignRun(opts: { engine: string; threads: number; points: number; name: string; retain_nf2ff?: boolean }): Promise<Job | null> {
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
    job = await startRun({ ...(opts.points !== 801 ? { points: opts.points } : {}), ...(nodes ? { cells: nodes } : {}),
      ...(opts.retain_nf2ff ? { retain_nf2ff: true } : {}) });
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

/** Save/check without adopting another document during a picker, refresh or native Save fork. */
export async function prepareDesignSubmission(isCurrent: () => boolean = () => true): Promise<
  { target: SavedDesignTarget; error: null } | { target: null; error: string }
> {
  if (!designFile()) return { target: null, error: t("runner.optimize.noDesign") };
  const target = await prepareSavedDesign(isCurrent);
  if (!target?.isCurrent()) return { target: null, error: t("runner.optimize.notSaved") };
  if (checks().some((c) => c.severity === "error")) return { target: null, error: t("runner.optimize.fixErrors") };
  await refreshModels();
  if (!target.isCurrent()) return { target: null, error: t("runner.optimize.notSaved") };
  if (!models().some((m) => m.key === target.file.id)) return { target: null, error: t("runner.optimize.notAvailable") };
  // Fresh model defaults come from the saved design. A displayed result/older preview can
  // share the model id while carrying different parameters, so it must not seed this action.
  selectModel(target.file.id);
  return { target, error: null };
}

/** Prepare the shared optimizer form from the latest saved designer model and values. */
export async function prepareDesignOptimize(isCurrent: () => boolean = () => true): Promise<string | null> {
  const prepared = await prepareDesignSubmission(isCurrent);
  return prepared.error ?? (prepared.target?.isCurrent() ? null : t("runner.optimize.notSaved"));
}

export function attachDesignOptimize(job: Job) {
  setDesignJobId(job.id);
  setDesignResultError(null);
  setDesignDockTab("run");
}

let resultSeq = 0;
let resultController: AbortController | null = null;
let resultRequest: { file: string; key: string | undefined; jobId?: string; refreshing?: boolean } | null = null;
const follower = new ResultFollow();
export async function loadDesignResult(file: string, jobId?: string, refreshIndex = false): Promise<boolean> {
  const expectedModel = designFile()?.design.model.id;
  if (!expectedModel) return false;
  if (documentResultFiles(designFile(), jobs())?.has(file) === false) return false;
  const mine = ++resultSeq;
  resultController?.abort();
  const controller = new AbortController();
  resultController = controller;
  let timedOut = false;
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new Error(t(timedOut ? "load.runResultTimedOut" : "load.runResultChanged")));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
  const bounded = <T,>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);
  resultRequest = { file, key: resultStamp(index().find(entry => entry.file === file)), jobId, refreshing: refreshIndex };
  setDesignResultLoading(file);
  setDesignResultError(null);
  setFailedResultLoad(null);
  try {
    if (refreshIndex) { await bounded(loadIndex()); if (mine !== resultSeq) return false; }
    const stamp = resultStamp(index().find(entry => entry.file === file));
    resultRequest = { file, key: stamp, jobId };
    // one retry after 500 ms: right after a run the dev server can still answer the just-written
    // file with index.html (not JSON); the built app serves it directly
    const read = async () => {
      const r = await fetch(projectUrl(file), { cache: "no-store", signal: controller.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<unknown>;
    };
    let raw: unknown;
    // One deadline covers headers, body and the transient retry. Racing abort also releases
    // this selection if a transport ignores its signal; late completion cannot regain ownership.
    try { raw = await bounded(read()); } catch (error) {
      if (controller.signal.aborted) throw error;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      try { await bounded(new Promise<void>(ok => { retryTimer = setTimeout(ok, 500); })); }
      finally { clearTimeout(retryTimer); }
      if (mine !== resultSeq) return false;
      raw = await bounded(read());
    }
    const v = validateBundle(raw);
    if (!v.bundle) throw new Error(summarize(v.errors));
    if (mine !== resultSeq) return false;
    const entry = index().find(entry => entry.file === file);
    if (resultStamp(entry) !== stamp) return false;
    if (!matchesResultIndex(entry, v.bundle)) throw new Error(t("load.runResultChanged"));
    if (documentResultFiles(designFile(), jobs())?.has(file) === false) return false;
    requireDesignResult(v.bundle, expectedModel);
    setDesignResult({ file, bundle: v.bundle, jobId });
    // a run that did not converge keeps the dock on its Run tab: that is where the warning is
    // first shown (the result tabs carry it as a banner too), so the dock must not move away
    const stops = runQuality(v.bundle)?.verdict === "not-converged";
    if (designDockTab() === "run" && (!designJob() || isTerminal(designJob()!.status)) && !stops) showDesignDockTab("runs");
    return true;
  } catch (e) {
    if (mine !== resultSeq) return false;
    setFailedResultLoad({ file, jobId });
    if (storedDesignResult()?.file === file) setDesignResult(null);
    setDesignResultError(t("load.runResultFailed", { file, error: timedOut ? t("load.runResultTimedOut") : (e as Error).message }));
    return false;
  } finally {
    clearTimeout(deadline);
    controller.signal.removeEventListener("abort", onAbort);
    if (resultController === controller) resultController = null;
    if (mine === resultSeq) { resultRequest = null; setDesignResultLoading(null); }
  }
}

export function clearDesignResult() {
  batch(() => {
  resultSeq++;
  resultController?.abort();
  resultController = null;
  resultRequest = null;
  follower.dismiss();
  setDesignResultLoading(null);
  setDesignResult(null);
  setDesignResultError(null);
  setFailedResultLoad(null);
  setDesignJobId(null);
  showDesignDockTab("checks");
  });
}

/** Explicit gallery navigation: keep an open example; replace a user file, geometry preview
 * or a run of one of your designs with the last example opened, else the newest one. */
export async function openExamples() {
  setAppMode("results");
  const navigation = appModeRevision();
  let opened = openCount();
  const current = () => appMode() === "results" && appModeRevision() === navigation && openCount() === opened;
  const b = bundle();
  const entries = exampleEntries(await loadIndex());
  if (!current()) return;
  if (b && !b.preview && sourceOrigin() === "project" && entries.some((p) => p.file === source())) return;
  invalidatePreview();
  clearProject();
  opened = openCount();
  const last = lastProject();
  const pick = entries.find((p) => p.file === last && p.simulated) ?? newestResults(entries)[0] ?? entries[0];
  if (pick) await loadProject(pick.file, current);
}

// Watch the whole history, not only the job currently attached to the SSE stream. A run
// finished in the Run panel or a sweep belongs in this design's dock too.
createRoot(() => {
  createEffect(on([index, appMode], () => {
    const run = storedDesignResult();
    if (appMode() !== "design") return;
    const pending = resultRequest;
    if (pending?.refreshing) return; // The finishing job owns its index refresh and job ID.
    if (pending && pending.key !== resultStamp(index().find(entry => entry.file === pending.file)))
      void loadDesignResult(pending.file, pending.jobId);
    else if (!pending && run && !matchesResultIndex(index().find(entry => entry.file === run.file), run.bundle))
      void loadDesignResult(run.file, run.jobId);
  }, { defer: true }));
  createEffect(on(appMode, (mode) => {
    if (mode === "design" && designFile()) { quickPreview(); schedulePreview(0); }
  }));
  // SSE completion refreshes job history; entering a design also picks up external runs.
  createEffect(on([() => designFile()?.id, () => designFile()?.backup_scope, () => nativeDocumentFor(designFile())?.handle], () => {
    const running = designJob();
    const keepJob = running && !isTerminal(running.status) ? running.id : null;
    clearDesignResult();
    follower.reset();
    if (keepJob) {
      setDesignJobId(keepJob);
      showDesignDockTab("run");
    }
    if (designFile()) void refreshRuns();
  }));
  createEffect(on([jobs, () => designFile()?.id], () => {
    const file = designFile();
    if (!file) return;
    const latest = jobs().filter((j) => j.status === "done" && j.bundle && belongsToDesign(j) && j.kind !== "optimize")
      .sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0))[0];
    const key = latest ? `${latest.id}:${latest.finished}:${latest.bundle}` : "";
    if (!latest) {
      // An unrelated/empty job refresh does not own a manually selected or external result.
      // Switching designs already clears the result and cancels its pending request above.
      follower.reset();
      return;
    }
    const ticket = follower.begin(key);
    if (!ticket) return;
    // the index lists the new bundle for the navigation tree's Results
    void loadDesignResult(latest.bundle!, latest.id, true).then((success) => follower.finish(ticket, success));
  }));
  // a run of the open design that this window did not start (a terminal, a script, an agent, another
  // window; #7): follow it in the dock like the designer's own run, unless a run is followed already
  // or the open Run panel shows another, finished run in its progress card (that stays on screen).
  // Sweeps and optimizations keep their own dialogs; the dock's Queue tab lists them.
  createEffect(on([jobs, () => designFile()?.id], () => {
    const file = designFile();
    const shown = live.job;
    if (!file || (shown && (!isTerminal(shown.status) || (runOpen() && shown.id !== designJobId())))) return;
    const mine = jobs().filter((j) => belongsToDesign(j) && !isTerminal(j.status) && !j.sweep && j.kind !== "optimize");
    // the list is newest first: the running run, else the next one to start
    const pick = mine.find((j) => j.status === "running") ?? mine[mine.length - 1];
    if (pick) followInDesigner(pick, false);
  }));
  createEffect(on(notice, (n) => {
    if (n?.kind === "run" && belongsToDesign(n.job) && appMode() === "design") setNotice(null);
  }));
});
