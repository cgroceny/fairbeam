// State and actions of the in-app Run workflow: server detection, model/parameter form, live
// geometry preview, job submission, the live event stream of one job, and run history.
import { batch, createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { bundle, clearProject, loadIndex, loadProject, openBundle, openCount, setKeepCamera, source } from "../state";
import type { Bundle } from "../types";
import type { Design } from "../designer/types";
import { appMode } from "../workspace";
import type { Check as DesignCheck } from "../designer/checks";
import { projectUrl, publicUrl } from "../env";
import { api, ApiError, isTerminal, onApiFailure, type Health, type Job, type JobEvent, type ModelEntry, type ParamSpec, type ParamValue, type ProgressEvent, type RunInfo, type RunStats } from "./api";
import { loadHostRates } from "../lib/hostRates";
import { PreviewIdentity } from "./previewIdentity";
import { AUTO_THREADS, chooseRunThreads, readGeneralSettings, RUN_THREADS_AUTO, RUN_THREADS_KEY } from "../lib/generalSettings";
import { t } from "../i18n/index.ts";
import { updateInstalling } from "../lib/updateProgress.ts";

export type ServerState = "unknown" | "checking" | "online" | "offline";
export type PreviewState = "idle" | "loading" | "ready" | "error";

const PREVIEW_DEBOUNCE_MS = 400;

export const [serverState, setServerState] = createSignal<ServerState>("unknown");
export const [health, setHealth] = createSignal<Health | null>(null);
export const [models, setModels] = createSignal<ModelEntry[]>([]);
export const [runOpen, setRunOpen] = createSignal(false);
export const [modelKey, setModelKey] = createSignal<string>("");
/** raw form text per parameter key (numbers are parsed on send) */
export const [values, setValues] = createStore<Record<string, string>>({});
export const [fieldErrors, setFieldErrors] = createStore<Record<string, string>>({});
export const [threads, setThreadsSignal] = createSignal<number>(0);
let hasLiveThreadChoice = false;
const [engine, setEngineSignal] = createSignal<string>("cpu");
export { engine };
/** Where the engine choice comes from: General settings' default, or a run set up in this session
 * (the Run dialog then labels it "Last used"). */
export const [engineSource, setEngineSource] = createSignal<"settings" | "session">("settings");
/** The engine picked for a run (Run dialog, sweep, mesh convergence, Run panel): later runs of this
 * session start from it, also after the server is found again. */
export function setEngine(e: string) {
  setEngineSignal(e);
  setEngineSource("session");
}
/** General settings' default engine, at start and when it changes there: it replaces a session's
 * choice, the newest one the user made. */
export function followSettingsEngine(e: string) {
  setEngineSignal(e);
  setEngineSource("settings");
}
export const [previewState, setPreviewState] = createSignal<PreviewState>("idle");
export const [previewError, setPreviewError] = createSignal<string | null>(null);
export const [previewActive, setPreviewActive] = createSignal(false);
export const [previewMs, setPreviewMs] = createSignal<number | null>(null);
/** The designer's last failed server preview, kept until a later preview of the current draft
 * succeeds (or the document or the shown project changes). previewError/previewState describe only
 * the request in flight and reset with every edit; this keeps saying that the mesh numbers and
 * server checks on screen are from the last successful preview, not from the current draft. */
export const [previewFailure, setPreviewFailure] = createSignal<string | null>(null);
/** The latest preview of the designer's draft (the browser-built one, then the server's), kept apart
 * from the viewer's bundle(): a run's results shown in the designer replace bundle(), not the draft's
 * mesh. The mesh readouts and the time estimates of the design read this (draftMesh.ts). */
const [draftPreview, setDraftPreview] = createSignal<Bundle | null>(null);
export { draftPreview };
/** The bundle whose mesh describes what the next run simulates: the draft's own preview in the
 * designer, the shown project (the Run panel's preview of a model) elsewhere. */
export const meshSource = (): Bundle | null => (appMode() === "design" ? draftPreview() : bundle());
/** Another document was opened in the designer: forget the last one's preview failure and preview. */
export const forgetPreviewFailure = () => { setPreviewFailure(null); setDraftPreview(null); };
/** How the mesh numbers of the shown bundle relate to the current inputs: "current" (a successful
 * server preview of them, or a project/result that is not a preview), "updating" (the server
 * preview of the latest edit is pending), "stale" (the last preview failed: the numbers are from
 * the last successful one) or "unknown" (it failed and no preview of this design is shown). */
export type MeshFreshness = "current" | "updating" | "stale" | "unknown";
export const meshFreshness = (): MeshFreshness =>
  previewFailure() !== null ? (previewActive() ? "stale" : "unknown")
    : previewState() === "loading" || (previewActive() && previewState() !== "ready") ? "updating" : "current";
export const [submitting, setSubmitting] = createSignal(false);
export const [submitError, setSubmitError] = createSignal<string | null>(null);
/** the technical side of the last submit failure (HTTP status and path), shown under "Details" */
export const [submitErrorDetail, setSubmitErrorDetail] = createSignal<string>("");
export const [jobs, setJobs] = createSignal<Job[]>([]);
export type Notice =
  | { kind: "run"; job: Job; bundle: string }
  | { kind: "sweep"; sweepId: string; name: string; done: number; total: number }
  | { kind: "optimize"; job: Job; reason: string; best: Record<string, number> | null; bestFile: string | null };
export const [notice, setNotice] = createSignal<Notice | null>(null);
/** "single" run or parameter "sweep" (src/runner/sweep.ts) */
export const [mode, setMode] = createSignal<"single" | "sweep" | "optimize">("single");
/** optional run / sweep name; the bundle file name is its slug */
export const [runName, setRunName] = createSignal("");
export const [copyExampleKey, setCopyExampleKey] = createSignal<string | null>(null);
export const [copyExampleFile, setCopyExampleFile] = createSignal<string | null>(null);
export const openExampleCopy = (key: string, file?: string) => { setCopyExampleFile(file ?? null); setCopyExampleKey(key); };

let saved: { bundle: Bundle | null; source: string } | null = null;
let previewOpenCount = -1;

// ------------------------------------------------------------------ server detection

/** A server that stopped answering is "offline", except during an app update: the shell stops it on
 * purpose before it installs and restarts (lib/updateProgress.ts), and the update indicator says so. */
function markServerLost() {
  if (!updateInstalling()) setServerState("offline");
}

let probing: Promise<boolean> | null = null;
/** the server answered once in this window: a lost server is worth looking for again (watchServer),
 * a viewer that never had one (the examples without a server) is not */
let everOnline = false;
export function probeServer(): Promise<boolean> {
  if (probing) return probing;
  if (serverState() !== "online") setServerState("checking");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  probing = api
    .health(ctl.signal)
    .then(async (h) => {
      noteHealth(h, false); // the run list is fetched below anyway
      void loadHostRates(h, publicUrl("benchmarks.json"));
      setServerState("online");
      everOnline = true;
      // the Settings default, unless a run of this session chose an engine the server still has
      const pref = readGeneralSettings();
      if (engineSource() !== "session" || !(h.engines ?? ["cpu"]).includes(engine())) followSettingsEngine(pref.engine === "gpu" && !h.engines?.includes("gpu") ? "cpu" : pref.engine);
      setThreadsSignal(chooseRunThreads(h.cpu_count, hasLiveThreadChoice ? threads() : 0, storedRunThreads(), pref.threads, h.default_threads,
        { live: hasLiveThreadChoice && threads() === AUTO_THREADS, remembered: storedRunAuto() }));
      await Promise.all([refreshModels(), refreshRuns()]);
      return true;
    })
    .catch(() => {
      markServerLost();
      return false;
    })
    .finally(() => {
      clearTimeout(timer);
      probing = null;
    });
  return probing;
}

/** Look at /api/health again whatever the state is: a server that is gone turns "Server online" to
 * offline (a failed request, the status bar's server button, a slow poll), a server that is back
 * turns it online. While the state is not online this is the full probe. */
let rechecking: Promise<boolean> | null = null;
export function recheckServer(): Promise<boolean> {
  if (serverState() !== "online") return probeServer();
  if (rechecking) return rechecking;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2500);
  rechecking = api
    .health(ctl.signal)
    .then((h) => { noteHealth(h, true); return true; })
    .catch(() => { markServerLost(); return false; })
    .finally(() => { clearTimeout(timer); rechecking = null; });
  return rechecking;
}
// A request that failed like a dead server (a 5xx answer, or no answer) makes the store look again
// while it still says "online": a proxy that answers 500 for a refused connection would otherwise
// leave "Server online" on screen next to a failed preview. A failure that already turned the state
// offline (no answer) is left to the probes that recover it (the next edit, the status bar's poll).
let failureTimer: ReturnType<typeof setTimeout> | undefined;
onApiFailure(() => {
  clearTimeout(failureTimer);
  failureTimer = setTimeout(() => { if (serverState() === "online") void recheckServer(); }, 300);
});

export function storedRunThreads(): number {
  try {
    const raw = localStorage.getItem(RUN_THREADS_KEY);
    if (raw === null || !/^\d+$/.test(raw)) return 0;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1) return n;
  } catch {
    /* ignore */
  }
  return 0;
}

/** true when the user picked Auto in Run (remembered apart from a manual number) */
export function storedRunAuto(): boolean {
  try { return localStorage.getItem(RUN_THREADS_KEY) === RUN_THREADS_AUTO; } catch { return false; }
}

/** The last manual thread count, kept while Auto is chosen: unticking Auto goes back to it. */
const LAST_MANUAL_THREADS_KEY = "fairbeam.run.threads.manual";
export function lastManualThreads(): number {
  try {
    const n = Number(localStorage.getItem(LAST_MANUAL_THREADS_KEY));
    if (Number.isInteger(n) && n >= 1) return n;
  } catch {
    /* ignore */
  }
  return storedRunThreads();
}
function rememberManual(n: number) {
  try { if (Number.isInteger(n) && n >= 1) localStorage.setItem(LAST_MANUAL_THREADS_KEY, String(n)); } catch { /* ignore */ }
}

/** n >= 1 is a manual choice, 0 is Auto */
export function setThreads(n: number) {
  hasLiveThreadChoice = Number.isInteger(n) && n >= 0;
  setThreadsSignal(n);
  rememberManual(n);
  try {
    localStorage.setItem(RUN_THREADS_KEY, n === AUTO_THREADS ? RUN_THREADS_AUTO : String(n));
  } catch {
    /* ignore */
  }
}

/** General settings › Default CPU threads changed: the Run dialog starts from it at once, without a
 * reload. It stays a default: an earlier Run choice is forgotten (the newer default replaces it), not
 * overwritten with the Settings value. */
export function followSettingsThreads(n: number) {
  hasLiveThreadChoice = false;
  rememberManual(n);
  try { localStorage.removeItem(RUN_THREADS_KEY); } catch { /* ignore */ }
  const h = health();
  setThreadsSignal(h ? chooseRunThreads(h.cpu_count, 0, 0, n, h.default_threads) : n);
}

export async function refreshModels() {
  try {
    const next = await api.models();
    const key = modelKey();
    if (key && JSON.stringify(models().find((m) => m.key === key)) !== JSON.stringify(next.find((m) => m.key === key))) {
      invalidatePreview();
    }
    setModels(next);
  } catch {
    /* keep the last list */
  }
}

// ------------------------------------------------------------------ the server's queue, whoever fills it

/** The queue of the last /api/health, as one comparable text; null before the first answer. */
let queueKey: string | null = null;
/** how many run-list refreshes a change of the queue has started (watchServer reads it) */
let queueRefreshes = 0;
const keyOf = (q: Health["queue"] | undefined) => (q ? `${q.running ?? ""}|${q.queued}|${q.version ?? ""}|${q.external ?? 0}` : "");

/** Keep an answer of /api/health. When its queue changed since the last one (a run was added,
 * started, ended or removed, also by another client: a terminal, a script, an agent; #7), the run
 * list is fetched again, and with it the results index when a run ended (refreshRuns). */
function noteHealth(h: Health, refresh: boolean) {
  setHealth(h);
  const key = keyOf(h.queue);
  const changed = queueKey !== null && key !== queueKey;
  queueKey = key;
  if (changed && refresh) {
    queueRefreshes++;
    void refreshRuns();
  }
}

let runsSeq = 0;
/** status of every run in the last list; null until the first list arrived */
let lastStatus: Map<string, Job["status"]> | null = null;
export async function refreshRuns() {
  const mine = ++runsSeq;
  try {
    const next = await api.runs();
    if (mine !== runsSeq) return;
    const before = lastStatus;
    lastStatus = new Map(next.map((j) => [j.id, j.status]));
    setJobs(next);
    // a stopped run is "stopping" until the list says it ended (its process takes a moment to exit)
    if (stopping().size) setStopping(new Set([...stopping()].filter((id) => { const s = lastStatus!.get(id); return s !== undefined && !isTerminal(s); })));
    // a run ended since the last list, also one this window neither started nor follows: its bundle
    // is in projects/index.json now (the Results list, the designer's tree)
    if (before && next.some((j) => j.status === "done" && before.get(j.id) !== "done")) void loadIndex();
  } catch {
    /* keep the last list */
  }
}

/** How often the open window looks at /api/health while it is visible. */
export const SERVER_POLL_MS = 5_000;
/** How often it looks for a server it had that stopped answering (a laptop back from sleep, a
 * server that stalled for a moment): a full probe, which brings "Server online" back. */
export const SERVER_LOST_POLL_MS = 10_000;
interface EventHost { addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void }

/** Keep the run list current while the app is open, whoever starts the runs:
 * look at /api/health every SERVER_POLL_MS while the window is visible and the server online (a
 * change of its queue refreshes the run list, noteHealth), and at once when the window comes back
 * (focus, visible again), when the run list is fetched too. A server this window had that stopped
 * answering (one health call that timed out turns the state offline) is probed every
 * SERVER_LOST_POLL_MS and when the window comes back, on every view, so the state does not stay
 * offline until the user asks. Returns the cleanup. */
export function watchServer(win: EventHost = window, doc: EventHost & { hidden: boolean } = document): () => void {
  const awake = () => !doc.hidden && serverState() === "online";
  const lost = () => !doc.hidden && everOnline && serverState() === "offline";
  let lostFor = 0;
  const poll = () => {
    if (awake()) { lostFor = 0; void recheckServer(); return; }
    if (!lost()) return;
    lostFor += SERVER_POLL_MS;
    if (lostFor >= SERVER_LOST_POLL_MS) { lostFor = 0; void probeServer(); }
  };
  let waking: Promise<unknown> | null = null;
  const wake = () => {
    if (waking) return;
    // the full probe also fetches the run list and the models
    if (lost()) { waking = probeServer().finally(() => { waking = null; }); return; }
    if (!awake()) return;
    waking = (async () => {
      const before = queueRefreshes;
      await recheckServer();
      // a queue that looks the same can still hide runs that started and ended while away (an older
      // server without the version counter): fetch the list unless the health already did
      if (queueRefreshes === before && serverState() === "online") await refreshRuns();
    })().finally(() => { waking = null; });
  };
  const timer = setInterval(poll, SERVER_POLL_MS);
  win.addEventListener("focus", wake);
  doc.addEventListener("visibilitychange", wake);
  return () => {
    clearInterval(timer);
    win.removeEventListener("focus", wake);
    doc.removeEventListener("visibilitychange", wake);
  };
}

// ------------------------------------------------------------------ model + parameters

export const currentModel = createRoot(() => createMemo(() => models().find((m) => m.key === modelKey())));
export const specs = (): ParamSpec[] => currentModel()?.params ?? [];

export function formatValue(v: ParamValue): string {
  return String(v);
}

/** Parsed value for a spec, or the raw text when it does not parse (the server reports it). */
export function parsed(spec: ParamSpec, raw: string | undefined): ParamValue | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (spec.type === "int" || spec.type === "float") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (spec.type === "bool") return raw === "true";
  return raw;
}

export function isModified(spec: ParamSpec): boolean {
  const v = parsed(spec, values[spec.key]);
  return v !== undefined && v !== spec.default;
}

export function localError(spec: ParamSpec, raw: string | undefined): string | null {
  const v = parsed(spec, raw);
  if (v === undefined) return null;
  if (spec.type === "int" || spec.type === "float") {
    if (typeof v !== "number") return t("runner.param.number");
    if (spec.type === "int" && !Number.isInteger(v)) return t("runner.param.integer");
    const unit = spec.unit ? ` ${spec.unit}` : "";
    if (spec.minimum !== null && v < spec.minimum) return t("runner.param.min", { value: `${spec.minimum}${unit}` });
    if (spec.maximum !== null && v > spec.maximum) return t("runner.param.max", { value: `${spec.maximum}${unit}` });
  }
  return null;
}

export function paramPayload(): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const s of specs()) {
    const v = parsed(s, values[s.key]);
    if (v !== undefined) out[s.key] = v;
  }
  return out;
}

/** Pick a model and fill the form: from `fromBundle` params when it is that model, else defaults. */
export function selectModel(key: string, fromBundle?: Bundle | null) {
  invalidatePreview();
  const m = models().find((x) => x.key === key);
  const src = fromBundle && m?.model && fromBundle.model.id === m.model.id ? fromBundle : null;
  batch(() => {
    setModelKey(key);
    const next: Record<string, string> = {};
    for (const s of m?.params ?? []) {
      const p = src?.model.params.find((q) => q.key === s.key);
      next[s.key] = formatValue(p ? p.value : s.default);
    }
    setValues(reconcile(next));
    setFieldErrors(reconcile({}));
    setPreviewError(null);
    setSubmitError(null);
  });
}

/** A model file changed (saved in the editor): replace its entry, and keep the form values the
 * user changed while unchanged ones follow the (possibly new) defaults. */
export function applyModelEntry(entry: ModelEntry) {
  const list = models();
  const before = list.find((m) => m.key === entry.key);
  setModels(before ? list.map((m) => (m.key === entry.key ? entry : m)) : [...list, entry].sort((a, b) => a.key.localeCompare(b.key)));
  if (modelKey() !== entry.key) return;
  invalidatePreview();
  if (entry.error) return;
  const next: Record<string, string> = {};
  for (const s of entry.params ?? []) {
    const old = before?.params?.find((p) => p.key === s.key);
    const raw = values[s.key];
    const edited = old && raw !== undefined && raw !== formatValue(old.default) && old.type === s.type;
    next[s.key] = edited ? raw : formatValue(s.default);
  }
  batch(() => {
    setValues(reconcile(next));
    setFieldErrors(reconcile({}));
  });
}

export function setValue(key: string, raw: string) {
  setValues(key, raw);
  setFieldErrors(key, undefined!);
  schedulePreview();
}

export function resetValue(spec: ParamSpec) {
  setValue(spec.key, formatValue(spec.default));
}

export function resetAll() {
  for (const s of specs()) setValues(s.key, formatValue(s.default));
  setFieldErrors(reconcile({}));
  schedulePreview();
}

// ------------------------------------------------------------------ preview

let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewCtl: AbortController | null = null;
const previewIdentity = new PreviewIdentity();

/** Supersede an in-flight preview as soon as its inputs or document change, before any debounce. */
function supersedePreview(): number {
  clearTimeout(previewTimer);
  previewTimer = undefined;
  previewCtl?.abort();
  previewCtl = null;
  const generation = previewIdentity.invalidate(openCount());
  setPreviewState("idle");
  setPreviewError(null);
  setPreviewMs(null);
  return generation;
}

export function invalidatePreview(): number {
  return supersedePreview();
}

/** Scheduled designer work follows our own quick opens, but expires on external opens. */
export function previewIsCurrent(seq: number): boolean {
  return previewIdentity.isCurrent(seq, openCount());
}

function currentPreview(seq: number): boolean {
  if (previewIdentity.isCurrent(seq, openCount())) return true;
  // A project was opened outside showPreview while this request was pending.
  if (previewIdentity.isLatest(seq)) invalidatePreview();
  return false;
}

export function schedulePreview(delay = PREVIEW_DEBOUNCE_MS) {
  invalidatePreview();
  previewTimer = setTimeout(runPreview, delay);
}

export async function runPreview() {
  const seq = supersedePreview();
  const m = currentModel();
  if (!m || m.error || serverState() !== "online") return;
  const local = Object.fromEntries(specs().map((s) => [s.key, localError(s, values[s.key])]).filter(([, e]) => e)) as Record<string, string>;
  if (Object.keys(local).length) {
    setFieldErrors(reconcile(local));
    setPreviewState("error");
    setPreviewError(t("runner.fixForPreview"));
    return;
  }
  const ctl = (previewCtl = new AbortController());
  setPreviewState("loading");
  const t0 = performance.now();
  try {
    const r = await api.preview(m.key, paramPayload(), ctl.signal);
    // a project opened from the header meanwhile wins over this preview
    if (!currentPreview(seq) || !runOpen()) return;
    setFieldErrors(reconcile({}));
    setPreviewError(null);
    if (!showPreview(r.bundle)) return;
    setPreviewMs(Math.round(performance.now() - t0));
    setPreviewState("ready");
    setPreviewFailure(null);
  } catch (e) {
    if (!currentPreview(seq) || (e as Error).name === "AbortError" || !runOpen()) return;
    const err = e as ApiError;
    setFieldErrors(reconcile(err.fields ?? {}));
    setPreviewError(err.status === 0 ? t("runner.serverStopped") : err.message);
    setPreviewState("error");
    if (err.status === 0) markServerLost();
  } finally {
    if (previewCtl === ctl) previewCtl = null;
  }
}

/** The outcome of a designer preview that reached no verdict of the server on the current draft:
 * field errors and checks come from the server when it answered (a design that does not build);
 * `unavailable` says why there are none (no server, a network failure, a server error). */
export interface DesignPreviewResult { fields: Record<string, string>; checks: DesignCheck[]; unavailable?: string }

/** Preview an unsaved design (the designer's current state) with its own defaults. Field errors
 * come back keyed by the JSON path of the field, with the server's design checks (also when the
 * design does not build). A failure is remembered in previewFailure until a later preview of the
 * current draft succeeds. null: superseded by a later preview (or another open, or another mode). */
export async function runDesignPreview(design: Design): Promise<DesignPreviewResult | null> {
  const seq = supersedePreview();
  // look for the server again first: a server that is back makes the next edit current again
  if (serverState() !== "online" && !(await probeServer())) {
    if (!currentPreview(seq) || appMode() !== "design") return null;
    const why = t("common.serverUnreachable");
    setPreviewError(why);
    setPreviewState("error");
    setPreviewFailure(why);
    return { fields: {}, checks: [], unavailable: why };
  }
  if (!currentPreview(seq) || appMode() !== "design") return null;
  const ctl = (previewCtl = new AbortController());
  setPreviewState("loading");
  const t0 = performance.now();
  try {
    const r = await api.previewDesign(design, {}, ctl.signal);
    if (!currentPreview(seq) || appMode() !== "design") return null;
    setPreviewError(null);
    if (!showPreview(r.bundle)) return null;
    setPreviewMs(Math.round(performance.now() - t0));
    setPreviewState("ready");
    setPreviewFailure(null);
    return { fields: {}, checks: r.checks ?? [] };
  } catch (e) {
    if (!currentPreview(seq) || (e as Error).name === "AbortError" || appMode() !== "design") return null;
    const err = e as ApiError;
    const why = err.status === 0 ? t("runner.serverStopped") : err.message;
    setPreviewError(why);
    setPreviewState("error");
    setPreviewFailure(why);
    if (err.status === 0) markServerLost();
    const checks = err.data.checks as DesignCheck[] | undefined;
    return Array.isArray(checks) ? { fields: err.fields ?? {}, checks } : { fields: err.fields ?? {}, checks: [], unavailable: why };
  } finally {
    if (previewCtl === ctl) previewCtl = null;
  }
}

/** The designer's instant, browser-built preview of its draft (src/designer/geometry.ts); the
 * server preview replaces it a moment later. */
export function showQuickPreview(b: Bundle) {
  if (serverState() !== "online" || appMode() !== "design") return;
  try {
    showPreview(b);
  } catch {
    /* a draft the viewer cannot take yet: keep the last preview */
  }
}

/** An empty stage for a design without geometry yet (a new, empty project): a blank scene with
 * a work area of ±half mm, so the viewer does not keep showing the previous project. */
export function showEmptyDesign(name: string, half = 30) {
  invalidatePreview();
  const q = half / 4;
  showPreview({
    schema: "fairbeam.project/1", name: `${name} (empty)`, preview: true,
    model: { id: "empty-design", name, description: "", params: [] },
    solver: { excitation: { type: "gauss", f_min: 1e9, f_max: 3e9 }, boundaries: { "x-": "MUR", "x+": "MUR", "y-": "MUR", "y+": "MUR", "z-": "MUR", "z+": "MUR" }, end_criteria_db: -50, max_timesteps: 60000, engine: "openEMS", method: "FDTD" },
    parts: [], ports: [],
    mesh: { x: [-half, half], y: [-half, half], z: [-q, q], total_cells: 0 },
    domain: { min: [-half, -half, -q], max: [half, half, q] },
    focus: { min: [-half, -half, 0], max: [half, half, 0] },
  } as unknown as Bundle);
  setPreviewState("ready");
  setPreviewFailure(null);
}

// Any bundle opened outside showPreview (project picker, drop, a run's results, a late initial
// load) ends the preview, even if that bundle itself carries a preview flag.
createRoot(() =>
  createEffect(
    on(
      bundle,
      () => {
        if (openCount() !== previewOpenCount) {
          invalidatePreview();
          saved = null;
          setPreviewActive(false);
          setPreviewFailure(null);
        }
      },
      { defer: true },
    ),
  ),
);

function showPreview(b: Bundle): boolean {
  if (!previewIdentity.canOpen(openCount())) return false;
  const first = !previewActive();
  if (first) saved = { bundle: bundle(), source: source() };
  // keep the camera while editing; frame the first preview unless it is the same antenna
  const sameModel = !first || saved?.bundle?.model.id === b.model.id;
  setKeepCamera(sameModel);
  previewOpenCount = openCount() + 1;
  try {
    openBundle(b, b.name); // the server names it "<model> · <overrides> (preview)"
  } catch (e) {
    previewOpenCount = -1;
    if (first) saved = null;
    throw e;
  } finally {
    setKeepCamera(false);
  }
  previewIdentity.didOpen(openCount());
  setPreviewActive(true);
  if (appMode() === "design") setDraftPreview(b);
  return true;
}

/** Leave the preview and show the project that was open before it. */
export function restoreProject() {
  invalidatePreview();
  setPreviewFailure(null);
  if (!previewActive()) return;
  const s = saved;
  saved = null;
  setPreviewActive(false);
  setPreviewState("idle");
  if (s?.bundle) {
    setKeepCamera(s.bundle.model.id === bundle()?.model.id);
    try {
      openBundle(s.bundle, s.source);
    } finally {
      setKeepCamera(false);
    }
  } else {
    clearProject(); // also the source name, so Results does not list the closed preview
  }
}

// ------------------------------------------------------------------ panel

/** With an explicit model (Start screen), preview that pick with defaults. The toolbar instead
 * infers a model from the currently displayed bundle via ensureModel. */
export async function openRunPanel(key?: string) {
  setRunOpen(true);
  if (key !== undefined) selectModel(key);
  const ok = serverState() === "online" || (await probeServer());
  if (!ok) return;
  if (key !== undefined) await runPreview();
  else ensureModel();
}

/** Examples' "Run again" (#51, #87): the Run panel for ``key`` filled with the parameters of the
 * result ``from`` it came from. An explicit command, so it refreshes the form even when the form
 * already edits that model (two results of one model with different parameters); the toolbar's
 * openRunPanel() keeps in-progress edits instead. The result stays on screen: no preview. */
export async function openRunPanelFrom(key: string, from: Bundle) {
  setRunOpen(true);
  selectModel(key, from);
  if (serverState() !== "online") await probeServer();
}

/** Pick the model of the open project (with its parameter values) when the form has none or
 * shows another model; keep the form as it is when it already edits the project's model. */
export function ensureModel() {
  const b = bundle();
  const match = b ? models().find((m) => m.model?.id === b.model.id && !m.error) : undefined;
  const current = currentModel();
  if (current && !current.error && (!match || match.key === current.key || previewActive())) return;
  const first = match ?? models().find((m) => !m.error);
  if (first) {
    selectModel(first.key, match ? b : null);
    if (!match) runPreview();
  }
}

export function closeRunPanel() {
  setRunOpen(false);
  restoreProject();
}

// ------------------------------------------------------------------ live job

interface Live {
  job: Job | null;
  events: JobEvent[];
  connected: boolean;
}
export const [live, setLive] = createStore<Live>({ job: null, events: [], connected: false });
let es: EventSource | null = null;
let lastSeq = 0;
let attachedFinished = false; // replaying a finished job: no "run finished" banner

const EVENT_TYPES = ["status", "phase", "log", "info", "progress", "stats", "result", "error", "opt_start", "opt_eval", "opt_done"] as const;

export function detach() {
  es?.close();
  es = null;
  setLive("connected", false);
}

export function attach(job: Job) {
  detach();
  lastSeq = 0;
  attachedFinished = isTerminal(job.status);
  setLive(reconcile({ job, events: [], connected: false }));
  const source = new EventSource(api.eventsUrl(job.id));
  es = source;
  source.onopen = () => setLive("connected", true);
  const onEvent = (e: Event) => {
    if (es !== source) return; // a detached stream must not update the newly attached job
    if (!(e instanceof MessageEvent) || typeof e.data !== "string") {
      // connection error: EventSource reconnects by itself and resumes after Last-Event-ID
      if (source.readyState === EventSource.CLOSED) setLive("connected", false);
      return;
    }
    let ev: JobEvent;
    try {
      ev = JSON.parse(e.data) as JobEvent;
    } catch {
      return;
    }
    if (ev.seq <= lastSeq) return;
    lastSeq = ev.seq;
    apply(ev);
  };
  for (const t of EVENT_TYPES) source.addEventListener(t, onEvent);
}

/** Refresh the normal run index after the server materializes an optimization's best point. */
export async function saveOptimizationBest(id: string) {
  const result = await api.saveOptimizationBest(id);
  await loadIndex();
  await refreshRuns();
  return result;
}

function apply(ev: JobEvent) {
  setLive("events", live.events.length, ev);
  const j = live.job;
  if (!j) return;
  switch (ev.type) {
    case "status":
      setLive("job", { status: ev.status, ...(ev.error !== undefined ? { error: ev.error } : {}), ...(ev.bundle ? { bundle: ev.bundle } : {}) });
      if (ev.status === "running") setLive("job", "started", ev.at);
      if (isTerminal(ev.status)) {
        setLive("job", { finished: ev.at, duration_s: ev.duration_s ?? j.duration_s });
        onTerminal(ev.status, ev.bundle ?? live.job?.bundle ?? null);
      }
      break;
    case "phase":
      setLive("job", "phase", ev.phase);
      break;
    case "progress":
      setLive("job", "last_progress", ev);
      break;
    case "info": {
      const { seq: _s, t: _t, type: _ty, ...info } = ev;
      setLive("job", "info", (old) => ({ ...old, ...info }));
      break;
    }
    case "stats": {
      const { seq: _s, t: _t, type: _ty, ...stats } = ev;
      setLive("job", "stats", stats);
      break;
    }
    case "result":
      setLive("job", "bundle", ev.bundle);
      break;
  }
}

async function onTerminal(status: string, file: string | null) {
  const job = live.job ? { ...live.job } : null;
  const replay = attachedFinished;
  detach();
  await refreshRuns();
  if (!job || replay) return;
  if (job.sweep) {
    // follow the sweep: attach to its next unfinished run, announce the end once
    const siblings = jobs().filter((j) => j.sweep?.id === job.sweep!.id);
    const next = siblings.filter((j) => !isTerminal(j.status)).sort((a, b) => a.sweep!.index - b.sweep!.index)[0];
    if (next) { if (live.job?.id === job.id) attach(next); return; }
    await loadIndex();
    setNotice({ kind: "sweep", sweepId: job.sweep.id, name: job.sweep.name, done: siblings.filter((j) => j.status === "done").length, total: job.sweep.total });
    return;
  }
  if (job.kind === "optimize") {
    if (status === "done") {
      const fresh = jobs().find((j) => j.id === job.id) ?? job; // the list has the final stats
      const s = fresh.stats as { reason?: string; best_params?: Record<string, number>; best_file?: string };
      setNotice({ kind: "optimize", job: { ...job }, reason: s.reason ?? "done", best: s.best_params ?? null, bestFile: s.best_file ?? null });
    }
    return;
  }
  if (status === "done" && file) {
    await loadIndex();
    setNotice({ kind: "run", job: { ...job }, bundle: file });
  }
}

/** threads / engine / name shared by single runs and sweeps. No end criterion: the run keeps the
 * model's or design's own (the server passes `--end-db` only for an explicit `end_criteria_db`). */
export function runSettings() {
  const engines = health()?.engines ?? ["cpu"];
  return {
    threads: engine() === "gpu" ? 1 : threads(), // 0 = Auto: the server picks (api.ts sends "auto")
    ...(engines.length > 1 && engines.includes(engine()) ? { engine: engine() } : {}),
    ...(runName().trim() ? { name: runName().trim() } : {}),
  };
}

/** Set by the designer: whether the design `key` has unsaved edits in the designer. */
let unsavedDesign: (key: string) => boolean = () => false;
export function setUnsavedDesignCheck(check: (key: string) => boolean) { unsavedDesign = check; }

/** Submit a single run of the current model. `extra` adds per-run options (frequency points). Returns
 * the job, or null when it was not submitted (the reason is in submitError / fieldErrors). */
export async function startRun(extra: { points?: number; cells?: number } = {}): Promise<Job | null> {
  const m = currentModel();
  if (!m || submitting()) return null;
  setSubmitError(null);
  setSubmitErrorDetail("");
  if (unsavedDesign(m.key)) {
    // the server runs the file on disk: the edits on screen would silently not be simulated
    setSubmitError(t("runner.unsavedDesign"));
    return null;
  }
  const local = Object.fromEntries(specs().map((s) => [s.key, localError(s, values[s.key])]).filter(([, e]) => e)) as Record<string, string>;
  if (Object.keys(local).length) {
    setFieldErrors(reconcile(local));
    setSubmitError(t("runner.fixFirst"));
    return null;
  }
  setSubmitting(true);
  try {
    const job = await api.submit({ model: m.key, params: paramPayload(), ...runSettings(), ...extra });
    setNotice(null);
    attach(job);
    refreshRuns();
    return job;
  } catch (e) {
    const err = e as ApiError;
    setFieldErrors(reconcile(err.fields ?? {}));
    setSubmitError(err.status === 0 ? t("common.serverUnreachable") : err.message);
    setSubmitErrorDetail(err.detail ?? "");
    return null;
  } finally {
    setSubmitting(false);
  }
}

export async function cancelRun() {
  const j = live.job;
  if (!j || isTerminal(j.status)) return;
  try {
    await api.cancel(j.id);
  } catch (e) {
    setSubmitError((e as Error).message);
  }
}

/** What the server does besides the run this window follows (#7): a run another client started (a
 * terminal, a script, an earlier session) is running or queued, or `fairbeam run` processes outside
 * the server use the CPU. The run list is the source; /api/health fills in a running run the list
 * does not know yet. */
export interface ServerActivity {
  /** the server runs or queues any run */
  busy: boolean;
  /** the running run when this window does not follow it (null: none, or it is the followed one) */
  other: Job | null;
  /** the server runs a run this window does not follow (also one the list does not know yet) */
  otherRunning: boolean;
  /** runs waiting in the queue */
  queued: number;
  /** `fairbeam run` processes started outside the server */
  external: number;
}
export const serverActivity = createRoot(() => createMemo<ServerActivity>(() => {
  const followed = live.job && !isTerminal(live.job.status) ? live.job.id : null;
  const list = jobs();
  const active = list.filter((j) => !isTerminal(j.status));
  const q = health()?.queue;
  const listed = active.find((j) => j.status === "running") ?? null;
  // the health's running run counts only while the list has not heard of it (then it is newer)
  const unlisted = q?.running && !list.some((j) => j.id === q.running) ? q.running : null;
  const runningId = listed?.id ?? unlisted;
  return {
    busy: active.length > 0 || !!unlisted,
    other: listed && listed.id !== followed ? listed : null,
    otherRunning: !!runningId && runningId !== followed,
    queued: active.filter((j) => j.status === "queued").length,
    external: q?.external ?? 0,
  };
}));

/** Runs this window asked to stop that have not ended yet: a running run's process takes a moment
 * (up to the server's grace period) to exit after the cancel. Their Stop buttons say "Stopping…". */
export const [stopping, setStopping] = createSignal<ReadonlySet<string>>(new Set());
/** how soon to look again after stopping a running run, so its end shows before the next poll */
export const STOP_FOLLOW_UP_MS = 1500;

/** Stop a running run or take a queued one out of the queue: any run of the server, not only the
 * one this window follows (#8). The run list and the health are fetched again either way, and once
 * more shortly after stopping a running run (its process exits a moment later). */
export async function cancelJob(id: string): Promise<boolean> {
  setStopping(new Set([...stopping(), id]));
  let ok = false;
  try {
    const job = await api.cancel(id);
    ok = true;
    // its end bumps the queue's version: this look then fetches the list (noteHealth); a run that
    // takes longer to exit is picked up by the next poll
    if (!isTerminal(job.status)) setTimeout(() => { if (stopping().has(id)) void recheckServer(); }, STOP_FOLLOW_UP_MS);
    return true;
  } catch (e) {
    const err = e as ApiError;
    setSubmitError(err.status === 0 ? t("common.serverUnreachable") : err.message);
    return false;
  } finally {
    if (!ok) setStopping(new Set([...stopping()].filter((x) => x !== id)));
    await Promise.all([refreshRuns(), recheckServer()]);
  }
}

/** Take every queued run out of the queue; the running run goes on (#8). Returns how many. */
export async function clearQueue(): Promise<number> {
  try {
    return (await api.clearQueue()).cancelled.length;
  } catch (e) {
    const err = e as ApiError;
    setSubmitError(err.status === 0 ? t("common.serverUnreachable") : err.message);
    return 0;
  } finally {
    await Promise.all([refreshRuns(), recheckServer()]);
  }
}

/** Open a bundle below /projects/ by relative path (e.g. "optimizations/x/y.json"). */
export async function openBundlePath(path: string, label?: string) {
  invalidatePreview();
  saved = null;
  setPreviewActive(false);
  setPreviewState("idle");
  setNotice(null);
  const start = openCount();
  try {
    const r = await fetch(projectUrl(path), { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = (await r.json()) as Bundle;
    if (openCount() !== start) return; // something else was opened meanwhile
    openBundle(json, label ?? path);
  } catch (e) {
    setSubmitError(t("load.openFailed", { file: path, error: (e as Error).message }));
  }
}

/** Load a finished run's bundle into the viewer (leaving any preview). */
export async function openResult(file: string) {
  invalidatePreview();
  if (bundle()?.preview) clearProject();
  const start = openCount();
  saved = null;
  setPreviewActive(false);
  setPreviewState("idle");
  setNotice(null);
  await loadIndex();
  if (openCount() === start) await loadProject(file);
}

// ------------------------------------------------------------------ derived views of the live job

export const liveEnergy = createRoot(() =>
  createMemo(() => {
    let pts: { ts: number; db: number }[] = [];
    let port: number | undefined;
    for (const e of live.events) {
      // multi-port: openEMS starts over for every driven port. Only another port starts a new line:
      // the first port's info can arrive after its first energy reading, which must stay
      if (e.type === "info" && e.port_run) {
        if (port !== undefined && e.port_run !== port) pts = [];
        port = e.port_run;
      } else if (e.type === "progress" && typeof e.energy_db === "number") pts.push({ ts: e.timestep, db: e.energy_db });
    }
    return pts;
  }),
);

export const liveLog = createRoot(() =>
  createMemo(() => live.events.filter((e): e is Extract<JobEvent, { type: "log" }> => e.type === "log").slice(-300)),
);

export const liveProgress = (): ProgressEvent | null => live.job?.last_progress ?? null;
export const liveInfo = (): RunInfo => live.job?.info ?? {};
export const liveStats = (): RunStats => live.job?.stats ?? {};
