// Optimizer (Run panel "Optimize" mode): the form state, submission, and derived views of the
// live optimize job's events (python/fairbeam/optimize.py, POST /api/optimizations).
import { createMemo, createRoot, createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { pinAll } from "../compare/store";
import { OPTIMIZE_SPAN, pickVaryParam, rangeAround } from "../lib/rangeDefaults";
import { bundle } from "../state";
import { meshStats } from "../designer/meshStats";
import { t, tEn } from "../i18n";
import { api, ApiError, type GoalKind, type OptDone, type OptEval, type OptGoal, type ParamSpec } from "./api";
import {
  attach,
  currentModel,
  health,
  jobs,
  live,
  meshSource,
  openBundlePath,
  paramPayload,
  refreshRuns,
  runName,
  setFieldErrors,
  setNotice,
  setSubmitError,
  setSubmitting,
  specs,
  submitting,
  threads,
  values,
} from "./store";

export const MAX_OPT_EVALS = 40;

export interface VaryDraft {
  key: string;
  min: string;
  max: string;
  start: string;
}
export interface GoalDraft {
  kind: GoalKind;
  target: string;
  at: string;
  weight: string;
  /** port numbers of S_ij (sij_max / sij_min) */
  i: string;
  j: string;
}

export interface GoalPreset {
  kind: GoalKind;
  /** i18n key of the goal's name */
  label: string;
  unit: string;
  needsAt: boolean;
  /** needs the port pair i, j */
  pair?: boolean;
  /** evaluated on the S-matrix of a multi-port model */
  multi?: boolean;
  /** i18n key of the goal's explanation */
  hint: string;
}

export const GOAL_PRESETS: GoalPreset[] = [
  { kind: "f0", label: "opt.goal.f0", unit: "GHz", needsAt: false, hint: "opt.goal.f0.hint" },
  { kind: "s11_max", label: "opt.goal.s11Max", unit: "dB", needsAt: true, hint: "opt.goal.s11Max.hint" },
  { kind: "bw_min", label: "opt.goal.bwMin", unit: "MHz", needsAt: false, hint: "opt.goal.bwMin.hint" },
  { kind: "dmax_min", label: "opt.goal.dmaxMin", unit: "dBi", needsAt: true, hint: "opt.goal.dmaxMin.hint" },
  { kind: "match_all", label: "opt.goal.matchAll", unit: "dB", needsAt: true, multi: true, hint: "opt.goal.matchAll.hint" },
  { kind: "sij_max", label: "opt.goal.sijMax", unit: "dB", needsAt: true, pair: true, multi: true, hint: "opt.goal.sijMax.hint" },
  { kind: "sij_min", label: "opt.goal.sijMin", unit: "dB", needsAt: true, pair: true, multi: true, hint: "opt.goal.sijMin.hint" },
];

export const presetOf = (kind: GoalKind) => GOAL_PRESETS.find((p) => p.kind === kind)!;

/** Port numbers of the current model: from its preview (or last opened result) when it is on screen. */
export const modelPorts = createRoot(() =>
  createMemo<number[] | null>(() => {
    const m = currentModel();
    const b = bundle();
    if (m && b && m.model && b.model.id === m.model.id) return b.ports.map((p) => p.number).sort((x, y) => x - y);
    // otherwise the last multi-port run of this model (ports numbered 1..n)
    const n = jobs().find((j) => j.model === m?.key && j.info?.port_total)?.info.port_total;
    return n ? Array.from({ length: n }, (_, k) => k + 1) : null;
  }),
);

/** Default draft of a goal kind at frequency f (GHz, as typed). */
export function goalDraft(kind: GoalKind, f: string, weight = "1"): GoalDraft {
  const n = modelPorts()?.length ?? 3;
  const target = { f0: f, s11_max: "-20", bw_min: "100", dmax_min: "5", match_all: "-20", sij_max: "-25", sij_min: "-3.5" }[kind];
  const [i, j] = kind === "sij_max" ? (n >= 3 ? ["2", "3"] : ["2", "1"]) : kind === "sij_min" ? ["2", "1"] : ["", ""];
  return { kind, target, at: presetOf(kind).needsAt ? f : "", weight, i, j };
}

export const [vary, setVary] = createStore<VaryDraft[]>([]);
export const [goals, setGoals] = createStore<GoalDraft[]>([]);
export const [maxEvals, setMaxEvals] = createSignal(12);
export type OptimizeMethod = "auto" | "secant" | "nelder-mead" | "bayesian" | "cma-es" | "particle-swarm" | "genetic" | "trust-region";
export const [method, setMethod] = createSignal<OptimizeMethod>("auto");
export const [optEngine, setOptEngine] = createSignal<string>("");
export const [optErrors, setOptErrors] = createSignal<Record<string, string>>({});

const numeric = () => specs().filter((s) => s.type === "int" || s.type === "float");
export const canAddVary = () => numeric().some((s) => !vary.some((v) => v.key === s.key));
const nice = (v: number) => Number(v.toPrecision(6));

/** Thread count sent to the solver; retain the user's CPU setting while GPU work uses one. */
export function threadsForEngine(engine: string, cpuThreads: number): number {
  return engine === "gpu" ? 1 : cpuThreads;
}

function currentValue(s: ParamSpec): number {
  const v = Number(values[s.key]);
  return Number.isFinite(v) && values[s.key]?.trim() ? v : Number(s.default);
}

/** Default bounds: the current value ±20 %, clipped to the parameter's limits (never its whole
 * min..max; see src/lib/rangeDefaults.ts). */
function defaultRange(s: ParamSpec): [number, number] {
  return rangeAround(currentValue(s), { min: s.minimum, max: s.maximum, int: s.type === "int" }, OPTIMIZE_SPAN);
}

/** The first parameter to vary: a geometric one. The design frequency and the band edges are what
 * the goals are measured at, so varying them to hit a frequency would be circular. */
export function defaultVarySpec(list: readonly ParamSpec[], used: ReadonlySet<string>): ParamSpec | undefined {
  const view = list.map((spec) => ({ key: spec.key, unit: spec.unit, min: spec.minimum, max: spec.maximum, spec }));
  return pickVaryParam(view, used)?.spec;
}

export function addVary() {
  const used = new Set(vary.map((v) => v.key));
  const s = defaultVarySpec(numeric(), used);
  if (!s) return;
  const [lo, hi] = defaultRange(s);
  const x = Math.min(hi, Math.max(lo, currentValue(s)));
  setVary(vary.length, { key: s.key, min: String(lo), max: String(hi), start: String(nice(x)) });
}

export function setVaryKey(i: number, key: string) {
  const s = specs().find((p) => p.key === key);
  if (!s) return;
  const [lo, hi] = defaultRange(s);
  const x = Math.min(hi, Math.max(lo, currentValue(s)));
  setVary(i, { key, min: String(lo), max: String(hi), start: String(nice(x)) });
}

export function removeVary(i: number) {
  setVary((v) => v.filter((_, k) => k !== i));
}

/** A sensible first goal: tune the resonance to the middle of the model's band. */
function bandCentre(): number {
  const lo = Number(values.f_min);
  const hi = Number(values.f_max);
  return Number.isFinite(lo) && Number.isFinite(hi) && hi > lo ? nice((lo + hi) / 2) : 2.4;
}

export function addGoal(kind: GoalKind = "f0") {
  if (goals.length >= 4) return;
  setGoals(goals.length, goalDraft(kind, String(bandCentre())));
}

/** Change a goal's kind, keeping its frequency and weight. */
export function setGoalKind(i: number, kind: GoalKind) {
  const g = goals[i];
  const f = g.kind === "f0" ? g.target : g.at || String(bandCentre());
  setGoals(i, goalDraft(kind, f, g.weight));
}

/** A first goal suited to the model: resonance for antennas, matching for multi-port circuits. */
function firstGoal(): GoalKind {
  return (modelPorts()?.length ?? 1) > 1 ? "match_all" : "f0";
}

/** Goal added by the "+ Goal" button. */
export function nextGoalKind(): GoalKind {
  const has = (k: GoalKind) => goals.some((g) => g.kind === k);
  if ((modelPorts()?.length ?? 1) > 1) return !has("sij_max") ? "sij_max" : !has("sij_min") ? "sij_min" : "match_all";
  return has("f0") ? "s11_max" : "f0";
}

// ------------------------------------------------------------------ driven ports (cost per evaluation)

export const [excite, setExcite] = createSignal<"auto" | "all">("auto");

/** Mirror of optimize.needed_excite: the ports each evaluation drives (one openEMS run each). */
export function neededPorts(list: { kind: GoalKind; i: number; j: number }[], numbers: number[]): number[] {
  if (numbers.length <= 1) return [...numbers];
  if (list.some((g) => g.kind === "match_all")) return [...numbers].sort((a, b) => a - b);
  const driven = new Set<number>();
  if (list.some((g) => !presetOf(g.kind).pair)) driven.add(numbers[0]);
  for (const g of list) {
    if (presetOf(g.kind).pair && !driven.has(g.i) && !driven.has(g.j)) driven.add(g.j);
  }
  return [...driven].sort((a, b) => a - b);
}

/** Ports driven per evaluation with the current form (null when the model's ports are unknown). */
export const drivenPorts = createRoot(() =>
  createMemo<number[] | null>(() => {
    const numbers = modelPorts();
    if (!numbers) return null;
    if (excite() === "all") return numbers;
    return neededPorts(goals.map((g) => ({ kind: g.kind, i: Number(g.i), j: Number(g.j) })), numbers);
  }),
);

export function removeGoal(i: number) {
  setGoals((g) => g.filter((_, k) => k !== i));
}

/** Fill the form for the current model when it is empty or belongs to another model. */
let formModel = "";

export function ensureOptimizeForm() {
  // the model's PARAMS are still loading: filling the form now would leave stale ranges behind
  if (!specs().length) return;
  const keys = new Set(specs().map((s) => s.key));
  const m = currentModel()?.key ?? "";
  const modelChanged = m !== formModel;
  if (modelChanged || !vary.length || vary.some((v) => !keys.has(v.key))) {
    setVary(reconcile([]));
    addVary();
  }
  if (modelChanged) {
    formModel = m;
    setGoals(reconcile([]));
    setExcite("auto");
  }
  if (!goals.length) addGoal(firstGoal());
  const engines = health()?.engines ?? ["cpu"];
  if (!optEngine() || !engines.includes(optEngine())) setOptEngine(engines.includes("gpu") ? "gpu" : "cpu");
}

/** Client-side check (the server validates again). */
export const optPlan = createRoot(() =>
  createMemo(() => {
    const errors: Record<string, string> = {};
    vary.forEach((v, i) => {
      const s = specs().find((p) => p.key === v.key);
      const lo = Number(v.min);
      const hi = Number(v.max);
      if (!s) errors[`vary.${i}`] = t("opt.err.chooseParam");
      else if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(lo < hi)) errors[`vary.${i}`] = t("opt.err.minMax");
      else if ((s.minimum !== null && lo < s.minimum) || (s.maximum !== null && hi > s.maximum))
        errors[`vary.${i}`] = t("opt.err.bounds", { min: s.minimum ?? "−∞", max: s.maximum ?? "∞", unit: s.unit });
      else if (!v.start.trim() || !Number.isFinite(Number(v.start)) || Number(v.start) < lo || Number(v.start) > hi) errors[`vary.${i}`] = t("opt.err.start");
    });
    const numbers = modelPorts();
    const isPort = (v: string) => /^\d+$/.test(v.trim()) && Number(v) >= 1 && (!numbers || numbers.includes(Number(v)));
    goals.forEach((g, i) => {
      const target = Number(g.target);
      const preset = presetOf(g.kind);
      if (!Number.isFinite(target)) errors[`goals.${i}`] = t("opt.err.targetNumber");
      else if ((g.kind === "f0" || g.kind === "bw_min") && target <= 0) errors[`goals.${i}`] = t("opt.err.targetPositive");
      else if ((g.kind === "s11_max" || g.kind === "sij_max" || g.kind === "match_all") && target >= 0) errors[`goals.${i}`] = t("opt.err.negativeDb");
      else if (g.kind === "sij_min" && target > 0) errors[`goals.${i}`] = t("opt.err.atMostZeroDb");
      else if (preset.needsAt && !(Number(g.at) > 0)) errors[`goals.${i}`] = t("opt.err.frequency");
      else if (preset.pair && !(isPort(g.i) && isPort(g.j)))
        errors[`goals.${i}`] = numbers ? t("opt.err.ports", { ports: numbers.join(", ") }) : t("opt.err.portNumbers");
      else if (!(Number(g.weight) > 0)) errors[`goals.${i}`] = t("opt.err.weight");
    });
    if (!vary.length) errors.vary = t("opt.err.noVary");
    if (!goals.length) errors.goals = t("opt.err.noGoal");
    if (!(maxEvals() >= 1 && maxEvals() <= MAX_OPT_EVALS)) errors.max_evals = t("opt.err.maxEvals", { max: MAX_OPT_EVALS });
    const auto = vary.length === 1 && goals.length === 1 && goals[0].kind === "f0" ? "secant" : "nelder-mead";
    return { errors, ok: Object.keys(errors).length === 0, method: method() === "auto" ? auto : method() };
  }),
);

/** Time of one openEMS run (one driven port) of the current model on the chosen engine, from the
 * last finished run: its duration divided by the number of ports it drove. */
export const perPortSeconds = () => {
  const m = currentModel();
  const eng = optEngine() || "cpu";
  const done = jobs().filter((j) => j.model === m?.key && j.status === "done" && j.kind !== "optimize" && j.duration_s);
  const same = done.find((j) => (j.engine ?? "cpu") === eng) ?? done[0];
  return same ? same.duration_s! / Math.max(1, same.info?.port_total ?? 1) : null;
};

/** Estimated time of one evaluation: per-port time × driven ports. */
export const lastEvalSeconds = () => {
  const s = perPortSeconds();
  return s === null ? null : s * Math.max(1, drivenPorts()?.length ?? 1);
};

export async function startOptimize() {
  const m = currentModel();
  const plan = optPlan();
  if (!m || submitting() || !plan.ok) return null;
  setSubmitError(null);
  setOptErrors({});
  setSubmitting(true);
  try {
    const base = paramPayload();
    for (const v of vary) delete base[v.key];
    const job = await api.submitOptimization({
      model: m.key,
      params: base,
      threads: threadsForEngine(optEngine() || "cpu", threads() || health()?.default_threads || 1),
      engine: optEngine() || undefined,
      ...(meshStats(meshSource())?.nodes ? { cells: meshStats(meshSource())!.nodes } : {}),
      ...(runName().trim() ? { name: runName().trim() } : {}),
      vary: vary.map((v) => ({ key: v.key, min: Number(v.min), max: Number(v.max), start: Number(v.start) })),
      goals: goals.map((g) => ({
        kind: g.kind,
        target: Number(g.target),
        at: presetOf(g.kind).needsAt ? Number(g.at) : null,
        weight: Number(g.weight) || 1,
        ...(presetOf(g.kind).pair ? { ports: [Number(g.i), Number(g.j)] as [number, number] } : {}),
      })),
      max_evals: maxEvals(),
      method: method(),
      excite: excite(),
    });
    setNotice(null);
    attach(job);
    refreshRuns();
    return job;
  } catch (e) {
    const err = e as ApiError;
    setOptErrors(err.fields ?? {});
    setFieldErrors(err.fields ?? {});
    setSubmitError(err.status === 0 ? t("common.serverUnreachable") : err.message);
    return null;
  } finally {
    setSubmitting(false);
  }
}

// ------------------------------------------------------------------ live optimize job

type EvalEvent = OptEval & { best_index: number; best_cost: number; max_evals: number; evaluations?: number; best_params?: Record<string, number>; best_file?: string | null; elapsed_s?: number; eta_s?: number };

export const optEvals = createRoot(() =>
  createMemo(() => live.events.filter((e): e is Extract<typeof e, { type: "opt_eval" }> => e.type === "opt_eval") as unknown as EvalEvent[]),
);

/** The optimize start line: model port numbers and the ports each evaluation drives. */
export const optStart = createRoot(() =>
  createMemo(() => {
    const e = live.events.find((x) => x.type === "opt_start");
    return e ? (e as unknown as { ports?: number[]; excite?: number[]; max_evals?: number }) : null;
  }),
);

export const optDone = createRoot(() =>
  createMemo(() => {
    const e = live.events.find((x) => x.type === "opt_done");
    return e ? (e as unknown as OptDone) : null;
  }),
);

export const optBest = createRoot(() =>
  createMemo(() => {
    const list = optEvals();
    if (!list.length) return null;
    return list.reduce((b, e) => (e.cost < b.cost ? e : b), list[0]);
  }),
);

export async function openBest() {
  const b = optDone()?.best ?? optBest();
  if (b?.file) await openBundlePath(b.file, labelOf(b));
}

/** Designer bridge contract: apply only the parameter values, leaving persistence to the caller. */
export function applyBestParams(): Record<string, number> | null {
  const best = optDone()?.best ?? optBest();
  return best ? { ...best.params } : null;
}

export async function compareBestVsStart() {
  const d = optDone();
  const best = d?.best ?? optBest();
  const start = d?.start ?? optEvals()[0];
  if (!best?.file) return;
  await openBundlePath(best.file, labelOf(best));
  if (start?.file && start.file !== best.file) await pinAll([start.file]);
}

export { fmtG, goalText } from "./optimizeGoals";
import { fmtG, goalText } from "./optimizeGoals";

/** Metric of a multi-port goal in an evaluation (null when unknown). */
export function goalValue(g: OptGoal, m: OptEval["metrics"]): number | null {
  if (g.kind === "match_all") return m.match_all_at?.[fmtG(g.at)]?.max ?? null;
  if ((g.kind === "sij_max" || g.kind === "sij_min") && g.ports) return m.sij_at?.[`${g.ports[0]},${g.ports[1]}@${fmtG(g.at)}`] ?? null;
  return null;
}

const sub = (i: number, j: number) => (i < 10 && j < 10 ? `S${i}${j}` : `S${i},${j}`);

export const pairName = (g: OptGoal) => (g.ports ? sub(g.ports[0], g.ports[1]) : "Sij");

export const labelOf = (e: OptEval) => t("opt.evalLabel", { params: Object.entries(e.params).map(([k, v]) => `${k}=${v}`).join(", "), index: e.index });

/** English goal text, for exported files */
export const goalTextEn = (g: OptGoal) => goalText(g, tEn);
