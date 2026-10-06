// Parameter sweeps from the Run panel: up to two axes, previewed client-side (count, values,
// estimated time) and expanded by the server (POST /api/sweeps) into individual jobs.
import { createMemo, createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { pinAll } from "../compare/store";
import { api, ApiError, isTerminal, type Job, type SweepAxisRequest } from "./api";
import { t } from "../i18n";
import { attach, currentModel, jobs, values, openResult, paramPayload, refreshRuns, runSettings, setFieldErrors, setNotice, setSubmitError, setSubmitting, specs, submitting } from "./store";

export const MAX_SWEEP_RUNS = 25;

export interface AxisDraft {
  key: string;
  kind: "range" | "list";
  start: string;
  stop: string;
  steps: string;
  list: string;
}

export const [axes, setAxes] = createStore<AxisDraft[]>([]);

const numericSpecs = () => specs().filter((s) => s.type === "int" || s.type === "float");

/** Same rounding as the server (10 significant digits). */
const nice = (v: number) => Number(v.toPrecision(10));

export function axisValues(a: AxisDraft): { values: number[]; error: string | null } {
  const spec = specs().find((s) => s.key === a.key);
  if (!spec) return { values: [], error: t("sweep.axis.chooseParam") };
  let values: number[];
  if (a.kind === "list") {
    const parts = a.list.split(/[\s,;]+/).filter(Boolean);
    values = parts.map(Number);
    if (!parts.length) return { values: [], error: t("sweep.axis.enterValues") };
    if (values.some((v) => !Number.isFinite(v))) return { values: [], error: t("sweep.axis.notNumbers") };
  } else {
    const start = Number(a.start);
    const stop = Number(a.stop);
    const steps = Number(a.steps);
    if (a.start.trim() === "" || a.stop.trim() === "" || !Number.isFinite(start) || !Number.isFinite(stop)) return { values: [], error: t("sweep.axis.startStop") };
    if (!Number.isInteger(steps) || steps < 1 || steps > MAX_SWEEP_RUNS) return { values: [], error: t("sweep.axis.steps", { max: MAX_SWEEP_RUNS }) };
    values = steps === 1 ? [start] : Array.from({ length: steps }, (_, k) => nice(start + ((stop - start) * k) / (steps - 1)));
  }
  if (spec.type === "int") values = values.map(Math.round);
  values = [...new Set(values)];
  const unit = spec.unit ? ` ${spec.unit}` : "";
  for (const v of values) {
    if (spec.minimum !== null && v < spec.minimum) return { values, error: t("sweep.axis.belowMin", { value: String(v), min: String(spec.minimum), unit }) };
    if (spec.maximum !== null && v > spec.maximum) return { values, error: t("sweep.axis.aboveMax", { value: String(v), max: String(spec.maximum), unit }) };
  }
  return { values, error: null };
}

export const sweepPlan = createRoot(() =>
  createMemo(() => {
    const per = axes.map(axisValues);
    const count = per.reduce((n, a) => n * a.values.length, axes.length ? 1 : 0);
    const errors = per.map((a) => a.error);
    let error = errors.find(Boolean) ?? null;
    if (!error && count > MAX_SWEEP_RUNS) error = t("sweep.axis.tooMany", { n: count, max: MAX_SWEEP_RUNS });
    if (!error && !axes.length) error = t("sweep.axis.none");
    return { per, count, error };
  }),
);

/** Duration of the last finished run of the current model, if any (for the time estimate). */
export const lastDuration = () => {
  const m = currentModel();
  const done = jobs().filter((j) => j.model === m?.key && j.status === "done" && j.duration_s);
  return done.length ? { seconds: done[0].duration_s!, threads: done[0].threads } : null;
};

export function addAxis() {
  const used = new Set(axes.map((a) => a.key));
  const spec = numericSpecs().find((s) => !used.has(s.key));
  if (!spec || axes.length >= 2) return;
  const cur = Number(values[spec.key]);
  const d = Number.isFinite(cur) && values[spec.key]?.trim() ? cur : Number(spec.default);
  const fmt = (v: number) => String(nice(v));
  setAxes(axes.length, { key: spec.key, kind: "range", start: spec.minimum === null ? "" : fmt(spec.minimum), stop: spec.maximum === null ? "" : fmt(spec.maximum), steps: "3", list: `${fmt(d * 0.95)}, ${fmt(d)}, ${fmt(d * 1.05)}` });
}

export function removeAxis(i: number) {
  setAxes((a) => a.filter((_, k) => k !== i));
}

export function resetAxes() {
  setAxes([]);
}

export async function startSweep() {
  const m = currentModel();
  const plan = sweepPlan();
  if (!m || submitting() || plan.error) return;
  setSubmitError(null);
  setSubmitting(true);
  try {
    const sweep: SweepAxisRequest[] = axes.map((a) =>
      a.kind === "list" ? { key: a.key, values: axisValues(a).values } : { key: a.key, start: Number(a.start), stop: Number(a.stop), steps: Number(a.steps) },
    );
    const base = paramPayload();
    for (const a of axes) delete base[a.key];
    const res = await api.submitSweep({ model: m.key, params: base, sweep, ...runSettings() });
    setNotice(null);
    await refreshRuns();
    if (res.runs[0]) attach(res.runs[0]);
  } catch (e) {
    const err = e as ApiError;
    setFieldErrors(err.fields ?? {});
    setSubmitError(err.status === 0 ? t("common.serverUnreachable") : err.message);
  } finally {
    setSubmitting(false);
  }
}

// ------------------------------------------------------------------ sweep groups in the history

export interface SweepGroup {
  id: string;
  name: string;
  model: string;
  created: number;
  jobs: Job[];
  total: number;
  done: number;
  active: boolean;
  keys: string[];
}

type SequenceMeta = { sequence_index?: number; sequence_name?: string };
const sequenceMeta = (j: Job) => (j.sweep as (Job["sweep"] & SequenceMeta))!;

/** History entries: single jobs and sweep groups, newest first. */
export const historyItems = createRoot(() =>
  createMemo(() => {
    const out: ({ kind: "job"; job: Job } | { kind: "sweep"; group: SweepGroup })[] = [];
    const groups = new Map<string, SweepGroup>();
    for (const j of jobs()) {
      if (!j.sweep) {
        out.push({ kind: "job", job: j });
        continue;
      }
      let g = groups.get(j.sweep.id);
      if (!g) {
        g = { id: j.sweep.id, name: j.sweep.name, model: j.model_id ?? j.model, created: j.created, jobs: [], total: j.sweep.total, done: 0, active: false, keys: j.sweep.axes.map((a) => a.key) };
        groups.set(j.sweep.id, g);
        out.push({ kind: "sweep", group: g });
      }
      g.jobs.push(j);
      for (const axis of j.sweep.axes) if (!g.keys.includes(axis.key)) g.keys.push(axis.key);
      g.created = Math.min(g.created, j.created);
      if (j.status === "done") g.done++;
      if (!isTerminal(j.status)) g.active = true;
    }
    // run order: the server numbers runs across all sequences in order, so the index alone keeps the
    // sequences in order and the points of a sequence in order (sequence_index alone ties within one)
    for (const g of groups.values()) g.jobs.sort((a, b) => a.sweep!.index - b.sweep!.index);
    return out;
  }),
);

/** Up to three finished runs spread over the sweep (first, middle, last). */
export function pickForCompare(g: SweepGroup): Job[] {
  const done = g.jobs.filter((j) => j.status === "done" && j.bundle);
  if (done.length <= 3) return done;
  return [done[0], done[Math.floor((done.length - 1) / 2)], done[done.length - 1]];
}

/** Open the first picked run and pin the others (compare/store). */
export async function compareSweep(g: SweepGroup) {
  const pick = pickForCompare(g);
  if (!pick.length) return;
  await openResult(pick[0].bundle!);
  await pinAll(pick.slice(1).map((j) => j.bundle!));
}

export async function cancelSweep(id: string) {
  try {
    await api.cancelSweep(id);
    await refreshRuns();
  } catch (e) {
    setSubmitError((e as Error).message);
  }
}

export interface SummaryRow {
  job: Job;
  values: Record<string, number>;
  fCenter: number | null;
  s11Min: number | null;
  dmax: number | null;
  eff: number | null;
}

/** Per-run results of a sweep from the job stats (first band, first far-field frequency). */
export function summaryRows(g: SweepGroup): SummaryRow[] {
  return g.jobs.map((j) => {
    const band = j.stats.bands?.[0];
    const ff = j.stats.farfield?.[0];
    return {
      job: j,
      values: j.sweep!.values,
      fCenter: band?.f_center_ghz ?? null,
      s11Min: band?.s11_min_db ?? null,
      dmax: ff?.dmax_dbi ?? null,
      eff: ff?.rad_efficiency ?? null,
    };
  });
}

/** Stable long-form comparison data. One row for every job, including unfinished/failed jobs. */
export function sweepLongTable(g: SweepGroup) {
  const columns = ["run_index", "sequence_index", "sequence_name", "status", ...g.keys, "band_center_ghz", "s11_min_db", "dmax_dbi", "radiation_efficiency_pct"];
  const rows = g.jobs.map((j) => {
    const meta = sequenceMeta(j);
    const band = j.stats.bands?.[0];
    const ff = j.stats.farfield?.[0];
    return [j.sweep!.index, meta.sequence_index ?? 0, meta.sequence_name ?? "", j.status,
      ...g.keys.map((key) => j.sweep!.values[key] ?? ""), band?.f_center_ghz ?? "", band?.s11_min_db ?? "", ff?.dmax_dbi ?? "", ff?.rad_efficiency == null ? "" : ff.rad_efficiency * 100];
  });
  return { columns, rows };
}

const csvCell = (value: string | number) => {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
export function sweepLongCsv(g: SweepGroup): string {
  const table = sweepLongTable(g);
  return [table.columns, ...table.rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
