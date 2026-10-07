// A design's runs in Design mode (#51, #52): the runs listed under Results in the navigation tree,
// and what selecting one does. The selection is the result focus (resultFocus.ts); this module
// follows it: the run's bundle becomes the dock's result (designRun.ts designResult) and is shown in
// the 3D view in place of the geometry preview, with the pattern or the surface currents on for
// those views. Back to geometry (a geometry node, an edit, leaving the design) the preview returns.
import { createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import type { Bundle } from "../types";
import { projectUrl } from "../env";
import { nearestIndex } from "../lib/rf";
import { indexQuality, runQuality, type RunQuality } from "../lib/runQuality";
import { summarize, validateBundle } from "../lib/validate";
import { appMode } from "../workspace";
import { bundle, index, openBundle, setFarfieldIndex, setFieldPlaneMap, setKeepCamera, setLayers } from "../state";
import { invalidatePreview, jobs, models } from "../runner/store";
import { designResult, loadDesignResult } from "../runner/designRun";
import { file as designFile, quickPreview, schedulePreview, selection } from "./store";
import { focusResult, followResultInDock, resultFocus, resultTarget, type ResultFocus, type ResultTarget, type ResultView } from "./resultFocus";
import { MAX_COMPARE, resultNodes, runContent, runRows, type RunContent } from "./navModel";
import { pickProjectRuns } from "./compareSelection";
import { projectLabels } from "../lib/projectLabels";
import { bundleMetrics, indexMetrics, metricsLine, rawMetrics, type RunMetrics } from "./runSummary";
import { activeMainResult } from "./mainTabsState";
import { runLetters } from "./resultTabs";
import { fmt } from "../i18n";

/** The runs of the open design, newest first, labelled for the tree (name · time · engine). */
export const designRuns = createRoot(() => createMemo(() => {
  const f = designFile();
  const model = f?.design.model.id;
  if (!f || !model) return [];
  // job history has sub-second completion times; bundle timestamps only have seconds
  const finished = new Map<string, number>();
  // a sweep's runs are named by their sweep point (navModel.ts runRows)
  const sweepValues = new Map<string, Record<string, number>>();
  for (const j of jobs()) {
    if (j.status === "done" && j.bundle && j.finished && j.model === f.id)
      finished.set(j.bundle, Math.max(finished.get(j.bundle) ?? 0, j.finished * 1000));
    if (j.status === "done" && j.bundle && j.model === f.id && j.sweep?.values && j.sweep.kind !== "convergence") sweepValues.set(j.bundle, j.sweep.values);
  }
  return runRows(index(), model, finished, sweepValues);
}));

export const designResultNodes = () => {
  const f = designFile();
  return f ? resultNodes(designRuns(), jobs(), f.design.model.id, runContentOf, (file) => metricsLine(runMetricsOf(file), fmt.fixed)) : [];
};

export const [sweepViewId, setSweepViewId] = createSignal<string | null>(null);
export function openSweepView(id: string) { setSweepViewId(id); }

/** Index metadata only: foreign bundles are fetched only after they are selected. */
export const otherProjectRuns = () => index().filter(entry => entry.simulated && entry.model !== designFile()?.design.model.id);
const indexedLabels = createRoot(() => createMemo(() => projectLabels(index())));
export const runLabel = (file: string) => {
  const local = designRuns().find(run => run.file === file);
  if (local) return local.label;
  const entry = index().find(run => run.file === file);
  if (!entry) return file.replace(/\.json$/i, "");
  const name = models().find(model => model.model?.id === entry.model)?.model?.name ?? entry.model;
  return `${indexedLabels().get(file) ?? entry.name} · ${name}`;
};

const letters = createRoot(() => createMemo(() => runLetters(designRuns().map((r) => r.file))));
/** A run's short label (A, B, C, ...; the oldest run is A): plot legends and the run table use it,
 * the run table spells out what it stands for. A file not among the design's runs keeps its label. */
export const runShortLabel = (file: string) => letters().get(file) ?? runLabel(file);

const jobFor = (file: string) => jobs().find((j) => j.status === "done" && j.bundle === file)?.id;

async function fetchRun(file: string): Promise<Bundle> {
  const r = await fetch(projectUrl(file), { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const v = validateBundle(await r.json());
  if (!v.bundle) throw new Error(summarize(v.errors));
  return v.bundle;
}

const bundleCache = new Map<string, Promise<Bundle>>();
/** Validated loader sharing in-flight requests only; a rerun can replace the same filename. */
export function loadRunBundle(file: string): Promise<Bundle> {
  let pending = bundleCache.get(file);
  if (!pending) {
    pending = fetchRun(file).finally(() => { bundleCache.delete(file); });
    bundleCache.set(file, pending);
  }
  return pending;
}

// ------------------------------------------------------------------ every run's bundle (on demand)

// The Compare picker's labels and the parameter-effect table need every run's parameters, which
// only the bundles carry in full. They are read when one of those is shown (not up front), once
// per run: a run listed again with another time (a re-run under the same file) is read again.
const [runBundleMap, setRunBundleMap] = createSignal<ReadonlyMap<string, { key: string; bundle: Bundle }>>(new Map());
const runBundleLoads = new Map<string, string>();

/** Read the bundles of the design's runs not read yet; call it from an effect of a view that needs
 * them (it tracks the run list). */
export function ensureDesignRunBundles() {
  const have = runBundleMap();
  const shown = designResult();
  for (const r of designRuns()) {
    const key = r.title;
    if (have.get(r.file)?.key === key || runBundleLoads.get(r.file) === key) continue;
    const known = shown?.file === r.file ? shown.bundle : comparedRuns().find((c) => c.file === r.file)?.bundle;
    if (known) {
      setRunBundleMap((m) => new Map(m).set(r.file, { key, bundle: known }));
      continue;
    }
    runBundleLoads.set(r.file, key);
    loadRunBundle(r.file).then((bundle) => {
      if (runBundleLoads.get(r.file) === key) setRunBundleMap((m) => new Map(m).set(r.file, { key, bundle }));
    }, () => { /* the picker keeps the run's list label; the table leaves the run out */ }).finally(() => {
      if (runBundleLoads.get(r.file) === key) runBundleLoads.delete(r.file);
    });
  }
}

/** A run's bundle once ensureDesignRunBundles has read it. */
export const designRunBundle = (file: string): Bundle | undefined => runBundleMap().get(file)?.bundle;

// ------------------------------------------------------------------ what a run holds (tree children)

const [contents, setContents] = createSignal<ReadonlyMap<string, RunContent>>(new Map());
const reading = new Set<string>();

// ------------------------------------------------------------------ run quality (tree and table badges)

const qualityByBundle = new WeakMap<Bundle, RunQuality | null>();
/** A bundle's quality verdict, computed once per bundle object. */
export function bundleQuality(b: Bundle): RunQuality | null {
  if (!qualityByBundle.has(b)) qualityByBundle.set(b, runQuality(b));
  return qualityByBundle.get(b) ?? null;
}
// the project index by file: its `quality` field badges a run whose bundle nothing has read yet
const indexedRuns = createRoot(() => createMemo(() => new Map(index().map((e) => [e.file, e]))));
// verdicts of runs known only from the raw JSON the tree read for their children
const [readQuality, setReadQuality] = createSignal<ReadonlyMap<string, RunQuality | null>>(new Map());

/** A run's quality verdict from whatever has been read of it (the shown run, a compared run, the
 * Runs table's bundles, the tree's reads); null while unknown or for a run without results. */
export function runQualityOf(file: string): RunQuality | null {
  const shown = designResult();
  if (shown?.file === file) return bundleQuality(shown.bundle);
  const compared = comparedRuns().find((c) => c.file === file);
  if (compared) return bundleQuality(compared.bundle);
  const read = runBundleMap().get(file);
  if (read) return bundleQuality(read.bundle);
  const known = readQuality().get(file);
  if (known !== undefined) return known;
  return indexQuality(indexedRuns().get(file));
}

// ------------------------------------------------------------------ headline metrics (tree, Runs table, Summary)

const metricsByBundle = new WeakMap<Bundle, RunMetrics | null>();
/** A bundle's headline numbers, computed once per bundle object. */
export function bundleRunMetrics(b: Bundle): RunMetrics | null {
  if (!metricsByBundle.has(b)) {
    let m: RunMetrics | null = null;
    try { m = bundleMetrics(b); } catch { /* an odd bundle has no headline */ }
    metricsByBundle.set(b, m);
  }
  return metricsByBundle.get(b) ?? null;
}
// headlines of runs known only from the raw JSON the tree read for their children
const [readMetrics, setReadMetrics] = createSignal<ReadonlyMap<string, RunMetrics | null>>(new Map());
// the index's `created` of each run when it was read: a run replaced under the same file is read again
const readStamp = new Map<string, string | undefined>();

/** A run's headline numbers from whatever has been read of it: the shown or a compared run, the Runs
 * table's bundles, the tree's reads, else what the project index says (the band centre, the verdict). */
export function runMetricsOf(file: string): RunMetrics | null {
  const shown = designResult();
  if (shown?.file === file) return bundleRunMetrics(shown.bundle);
  const compared = comparedRuns().find((c) => c.file === file);
  if (compared) return bundleRunMetrics(compared.bundle);
  const read = runBundleMap().get(file);
  if (read) return bundleRunMetrics(read.bundle);
  const raw = readMetrics().get(file);
  if (raw && readStamp.get(file) === indexedRuns().get(file)?.created) return raw;
  return indexMetrics(indexedRuns().get(file));
}

/** Far-field and surface-current frequencies of a run, once its bundle has been read. */
export function runContentOf(file: string): RunContent | null {
  const r = designResult();
  if (r?.file === file) return runContent(r.bundle);
  return contents().get(file) ?? null;
}

/** Read a run's bundle for its tree children (when its node opens). */
export async function readRunContent(file: string) {
  const stamp = indexedRuns().get(file)?.created;
  if ((contents().has(file) && readStamp.get(file) === stamp) || reading.has(file) || designResult()?.file === file) return;
  reading.add(file);
  try {
    const r = await fetch(projectUrl(file), { cache: "no-store" });
    if (r.ok) {
      const raw = await r.json();
      const c = runContent(raw);
      let q: RunQuality | null = null;
      try { q = runQuality(raw as Bundle); } catch { /* an odd bundle has no verdict */ }
      readStamp.set(file, stamp);
      setContents((m) => new Map(m).set(file, c));
      setReadQuality((m) => new Map(m).set(file, q));
      setReadMetrics((m) => new Map(m).set(file, rawMetrics(raw)));
    }
  } catch {
    /* the node keeps its fixed children; selecting a view reports the error */
  } finally {
    reading.delete(file);
  }
}

// ------------------------------------------------------------------ selecting runs and views

/** The selected runs: the focused one first, then the ones compared with it. */
export const selectedRuns = (): string[] => {
  const f = resultFocus();
  return f ? [f.file, ...(f.compare ?? [])] : [];
};

const COMPARABLE = new Set<ResultView>(["sparams", "impedance", "vswr", "smith", "efficiency", "pattern", "table", "summary"]);

/** A click on a run node: alone, or with Ctrl/⌘ added to (or removed from) the comparison.
 * false when the comparison is full. For the main area the run(s) show in its result tab. */
export function selectRun(file: string, additive: boolean, where: ResultTarget = "keep"): boolean {
  const local = new Set(designRuns().map(run => run.file));
  const shown = designResult();
  if (shown) local.add(shown.file); // loadDesignResult already enforces the active model.
  const current = selectedRuns();
  if (!current.length && shown && additive) current.push(shown.file);
  const { files, accepted } = pickProjectRuns(current, file, additive, local, MAX_COMPARE);
  if (!accepted) return false;
  const prev = (where === "main" ? activeMainResult() : null) ?? resultFocus()?.view ?? "sparams";
  const view = files.length > 1 && !COMPARABLE.has(prev) ? "sparams" : prev;
  focusResult({ file: files[0], view, ...(files.length > 1 ? { compare: files.slice(1) } : {}) }, where);
  return true;
}

/** A dock tab, a main-area tab or a chip: the same run(s), another view (and frequency). With
 * nothing focused, the dock's result is focused. */
export function showView(view: ResultView, f?: number, where: ResultTarget = "keep") {
  const cur = resultFocus();
  const file = cur?.file ?? designResult()?.file;
  if (!file) return;
  const next: ResultFocus = { ...(cur ?? { file }), view };
  if (f !== undefined) next.f = f;
  if (!COMPARABLE.has(view)) delete next.compare;
  focusResult(next, where);
}

/** A chip of the 3D view's far-field card: that entry of the shown run (its frequency, and its driven
 * port for multi-port runs, which share one frequency) as the 3D pattern. */
export function showPattern3dEntry(i: number) {
  const ff = designResult()?.bundle.results?.farfield?.[i];
  if (!ff) return;
  showView("pattern3d", ff.f);
  // the focus picks the first entry at a frequency; a multi-port run's other ports share it
  setFarfieldIndex(i);
}

// ------------------------------------------------------------------ compared runs

const [compared, setCompared] = createSignal<{ file: string; bundle: Bundle }[]>([]);
/** The bundles of the runs compared with the focused one (loaded, in selection order). */
export const comparedRuns = compared;
export const [comparedLoadState, setComparedLoadState] = createSignal<Record<string, "loading" | "error">>({});
const [compareRevision, setCompareRevision] = createSignal(0);
export const retryComparedRuns = () => setCompareRevision(value => value + 1);
export const comparisonReady = () => Object.keys(comparedLoadState()).length === 0;

// ------------------------------------------------------------------ the 3D view follows the focus

/** the viewer's copy of the shown run (openBundle validates into a new object) and its source */
let shownBundle: Bundle | null = null;
let shownSource: Bundle | null = null;
let opening = false;
/** the run this module asked designRun.ts to load (its arrival is not a new run to follow) */
let requested: string | null = null;

/** The 3D pattern or the surface currents at the focused frequency, drawn in the 3D view (which the
 * focus brought to the front); neither for the other views, so no layer stays on under a result tab
 * (the Pattern tab draws the cuts, not the 3D pattern). */
function applyView(f: ResultFocus, b: Bundle) {
  const ffs = b.results?.farfield ?? [];
  if ((f.view === "pattern" || f.view === "pattern3d" || f.view === "currents") && f.f !== undefined && ffs.length) setFarfieldIndex(nearestIndex(ffs.map((x) => x.f), f.f));
  setLayers({ pattern: f.view === "pattern3d" && ffs.length > 0, current: f.view === "currents" && !!b.fields });
  setFieldPlaneMap(f.view === "fieldplane" && f.map !== undefined && b.field_planes?.[f.map] ? f.map : null);
}

/** The run in the 3D view (opened once per bundle; the camera stays), then the focused view. */
function display(f: ResultFocus, r: { file: string; bundle: Bundle }) {
  if (appMode() !== "design") return;
  if (r.bundle !== shownSource || bundle() !== shownBundle) {
    invalidatePreview();
    opening = true;
    setKeepCamera(true);
    try {
      openBundle(r.bundle, r.file);
      shownBundle = bundle();
      shownSource = r.bundle;
    } catch {
      shownBundle = shownSource = null;
      return;
    } finally {
      setKeepCamera(false);
      opening = false;
    }
  }
  applyView(f, r.bundle);
}

function backToGeometry() {
  const showing = !!shownBundle && bundle() === shownBundle;
  shownBundle = shownSource = null;
  setLayers({ pattern: false, current: false });
  setFieldPlaneMap(null);
  if (showing && appMode() === "design" && designFile()) {
    quickPreview();
    schedulePreview(0);
  }
}

createRoot(() => {
  let seq = 0;
  createEffect(on(resultFocus, async (f, prev) => {
    const mine = ++seq;
    if (!f) {
      if (prev) backToGeometry();
      return;
    }
    if (appMode() !== "design") return;
    if (designResult()?.file !== f.file) {
      requested = f.file;
      const ok = await loadDesignResult(f.file, jobFor(f.file));
      if (mine !== seq) return;
      if (!ok) return focusResult(null);
    }
    const r = designResult();
    if (!r || r.file !== f.file) return;
    display(f, r);
    // the dock's Runs tab may not have existed before the bundle arrived (the dock had no result)
    followResultInDock(f.view);
  }));

  let cseq = 0;
  createEffect(on(() => `${compareRevision()}\0${(resultFocus()?.compare ?? []).join("\n")}`, async () => {
    const mine = ++cseq;
    const files = resultFocus()?.compare ?? [];
    // Removed curves disappear synchronously, before another bundle's response arrives.
    setCompared(previous => previous.filter(run => files.includes(run.file)));
    setComparedLoadState(Object.fromEntries(files.map(file => [file, "loading" as const])));
    const loaded = await Promise.all(files.map(async file => {
      try { return { file, bundle: await loadRunBundle(file) }; }
      catch { return null; }
    }));
    if (mine !== cseq) return;
    setCompared(loaded.filter((run): run is { file: string; bundle: Bundle } => !!run));
    setComparedLoadState(Object.fromEntries(files.flatMap((file, i) => loaded[i] ? [] : [[file, "error" as const]])));
  }));

  // something else replaced the run in the 3D view (a geometry preview after an edit, another open)
  createEffect(on(bundle, (b) => {
    if (opening || !resultFocus() || !shownBundle || b === shownBundle) return;
    shownBundle = shownSource = null;
    focusResult(null);
  }, { defer: true }));

  // a geometry node or a pick in the 3D view; leaving the design; another design
  createEffect(on(selection, () => focusResult(null), { defer: true }));
  createEffect(on(appMode, (m) => { if (m !== "design") focusResult(null); }, { defer: true }));
  createEffect(on(() => designFile()?.id, () => {
    focusResult(null);
    setContents(new Map());
    setReadQuality(new Map());
    setReadMetrics(new Map());
    readStamp.clear();
    bundleCache.clear();
    setRunBundleMap(new Map());
    runBundleLoads.clear();
  }, { defer: true }));

  // the dock's result changed under the focus: the focused run arrived or was re-run under the same
  // name (display it), a new run finished (follow it), or the run tabs were closed
  createEffect(on(designResult, (r) => {
    const f = resultFocus();
    if (!f) return;
    if (!r) focusResult(null);
    else if (r.file === f.file) { if (shownSource) display(f, r); }
    else if (r.file !== requested && !f.compare?.includes(r.file)) focusResult({ file: r.file, view: f.view }, resultTarget());
  }, { defer: true }));
});
