import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { ArrowDown, ArrowUp, CircleCheck, CircleX, Download, FolderOpen, GitCompareArrows, Square, TriangleAlert } from "lucide-solid";
import LineChart, { type Series } from "../charts/LineChart";
import { num, seconds } from "../lib/format";
import { saveDownload } from "../lib/download";
import { isTerminal } from "./api";
import { cancelRun, live, openBundlePath, saveOptimizationBest } from "./store";
import { StatusBadge } from "./status";
import { t, tEn } from "../i18n";
import { compareBestVsStart, fmtG, goalText, goalTextEn, goalValue, labelOf, openBest, optBest, optDone, optEvals, optStart, pairName, presetOf } from "./optimize";

const COST_FLOOR = 1e-3; // log scale: a met goal has cost 0

type Evaluation = ReturnType<typeof optEvals>[number];
/** An evaluation's status (an i18n key); a skipped one was never simulated (the design checks refused it). */
const statusOf = (e: Evaluation) => (e.skipped ? "opt.status.skipped" : e.error ? "opt.status.failed" : e.met ? "opt.status.met" : "opt.status.evaluated");

/** The optimizer's stop reasons (python/fairbeam/optimize.py) as i18n keys; others are shown as sent. */
const REASONS: Record<string, string> = {
  "max evaluations": "opt.reason.maxEvals",
  "simplex converged": "opt.reason.simplexConverged",
  "evaluation budget exhausted": "opt.reason.budgetExhausted",
  "trust region converged": "opt.reason.trustRegionConverged",
  "no resonance in the frequency range": "opt.reason.noResonance",
  "target outside the parameter bounds": "opt.reason.targetOutside",
  "parameter resolution reached": "opt.reason.resolution",
  "secant steps exhausted": "opt.reason.secantExhausted",
  done: "opt.reason.done",
};
const reasonText = (r: string) => (REASONS[r] ? t(REASONS[r]) : r);

/** Live card of an optimization job: cost per evaluation, the evaluations table, best point. */
export default function OptimizeProgress() {
  const [saveMessage, setSaveMessage] = createSignal("");
  const job = () => live.job!;
  const done = () => isTerminal(job().status);
  const spec = () => job().optimize;
  const keys = () => spec()?.vary.map((v) => v.key) ?? Object.keys(optEvals()[0]?.params ?? {});
  const s11Goal = () => spec()?.goals.find((g) => g.kind === "s11_max");
  const [now, setNow] = createSignal(Date.now() / 1000);
  createEffect(() => {
    if (done()) return;
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    onCleanup(() => clearInterval(id));
  });
  const elapsed = () => (job().started ? Math.max(0, (job().finished ?? now()) - job().started!) : null);
  const latest = () => optEvals().at(-1);
  const budget = () => spec()?.max_evals ?? latest()?.max_evals ?? 0;
  const progressPercent = () => budget() ? Math.min(100, Math.round(100 * (latest()?.evaluations ?? optEvals().length) / budget())) : 0;
  const eta = () => latest()?.eta_s;
  const exportHistory = async (format: "csv" | "json") => {
    const entries = optEvals();
    const name = `optimization-${job().id}-history.${format}`;
    if (format === "json") return saveDownload(name, JSON.stringify(entries, null, 2), "application/json");
    const paramKeys = [...new Set(entries.flatMap((e) => Object.keys(e.params)))];
    const goalNames = (spec()?.goals ?? []).map((g) => goalTextEn(g));
    const esc = (x: unknown) => `"${String(x ?? "").replaceAll('"', '""')}"`;
    const rows = entries.map((e) => [e.index, ...paramKeys.map((k) => e.params[k]), ...(spec()?.goals ?? []).map((g, i) => e.goals?.[i]?.value ?? goalValue(g, e.metrics)), e.cost, e.skipped ? `skipped: ${e.skipped}` : tEn(statusOf(e)).toLowerCase(), e.wall_time_s, e.file]);
    return saveDownload(name, [["index", ...paramKeys, ...goalNames, "cost", "status", "duration_s", "file"].map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n"), "text/csv;charset=utf-8");
  };
  const saveBestRun = async () => {
    if (!done()) return;
    try {
      const result = await saveOptimizationBest(job().id);
      setSaveMessage(t("opt.progress.saved", { file: result.file }));
    } catch (error) {
      setSaveMessage(t("opt.progress.saveError", { error: (error as Error).message }));
    }
  };

  const series = createMemo<Series[]>(() => {
    const e = optEvals();
    if (!e.length) return [];
    const x = e.map((v) => v.index);
    const y = e.map((v) => Math.log10(Math.max(v.cost, COST_FLOOR)));
    if (e.length === 1) {
      x.push(1.001);
      y.push(y[0]);
    }
    return [{ id: "cost", label: t("opt.cost"), color: "--al-series-1", x, y }];
  });
  const yDomain = createMemo<[number, number]>(() => {
    const y = series()[0]?.y ?? [0];
    return [Math.floor(Math.min(...y, -1)), Math.ceil(Math.max(...y, 1))];
  });

  type Col = { key: string; label: string; unit: string; digits: number; get: (e: ReturnType<typeof optEvals>[number]) => number | null };
  const multiGoals = () => (spec()?.goals ?? []).filter((g) => presetOf(g.kind)?.multi);
  // f0 / |S11| columns unless every goal is a multi-port one (a divider has no resonance)
  const antennaCols = () => !spec() || multiGoals().length < spec()!.goals.length;
  const cols = createMemo<Col[]>(() => [
    { key: "index", label: "#", unit: "", digits: 0, get: (e) => e.index },
    ...keys().map((k) => ({ key: `p:${k}`, label: k, unit: "", digits: 3, get: (e: ReturnType<typeof optEvals>[number]) => e.params[k] ?? null })),
    ...(antennaCols()
      ? [
          { key: "f0", label: "f0", unit: "GHz", digits: 4, get: (e: ReturnType<typeof optEvals>[number]) => e.metrics.f0_ghz },
          s11Goal()
            ? { key: "s11", label: "|S11|", unit: `dB @ ${s11Goal()!.at}`, digits: 1, get: (e: ReturnType<typeof optEvals>[number]) => e.metrics.s11_at?.[`${s11Goal()!.at}`] ?? null }
            : { key: "s11", label: "|S11| (f0)", unit: "dB", digits: 1, get: (e: ReturnType<typeof optEvals>[number]) => e.metrics.s11_f0_db ?? null },
        ]
      : []),
    ...multiGoals().map((g, k) => ({
      key: `g:${k}`,
      label: g.kind === "match_all" ? "max |Sii|" : `|${pairName(g)}|`,
      unit: `dB @ ${fmtG(g.at)}`,
      digits: 2,
      get: (e: ReturnType<typeof optEvals>[number]) => goalValue(g, e.metrics),
    })),
    // one column per goal, keyed by its index: the evaluation's goal parts come in goal order, and two
    // goals may share a kind (e.g. |S11| at two frequencies)
    ...(spec()?.goals ?? []).flatMap((g, i) => presetOf(g.kind)?.multi ? [] : [{
      key: `goal:${i}`, label: goalText(g), unit: "", digits: 3,
      get: (e: ReturnType<typeof optEvals>[number]) => e.goals?.[i]?.value ?? null,
    }]),
    { key: "cost", label: t("opt.cost"), unit: "", digits: 4, get: (e) => e.cost },
    { key: "status", label: t("opt.status"), unit: "", digits: 0, get: (e) => e.skipped ? 3 : e.error ? 2 : e.met ? 0 : 1 },
    { key: "time", label: t("opt.time"), unit: "s", digits: 2, get: (e) => e.wall_time_s },
  ]);
  const [sort, setSort] = createSignal<{ key: string; dir: 1 | -1 }>({ key: "index", dir: 1 });
  const rows = createMemo(() => {
    const col = cols().find((c) => c.key === sort().key) ?? cols()[0];
    return [...optEvals()].sort((a, b) => {
      const va = col.get(a);
      const vb = col.get(b);
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * sort().dir;
    });
  });
  const toggle = (key: string) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const best = () => optDone()?.best ?? optBest();
  const reason = () => optDone()?.reason;
  const met = () => reason() === "goals met";
  const outcome = () => {
    const n = optDone()?.evaluations ?? optEvals().length;
    const time = optDone()?.wall_time_s ? seconds(optDone()!.wall_time_s) : null;
    if (met()) return time ? t("opt.progress.metIn", { count: n, time }) : t("opt.progress.met", { count: n });
    const why = reasonText(reason() ?? "done");
    return time ? t("opt.progress.stoppedIn", { reason: why, count: n, time }) : t("opt.progress.stopped", { reason: why, count: n });
  };

  return (
    <section class="section rp-progress stack" aria-label={t("opt.progress.aria")} aria-busy={!done()}>
      <div class="cluster rp-progress-head">
        <StatusBadge status={job().status} />
        <span class="rp-job-title" title={job().id}>
          <span>{job().label ?? t("opt.optimization")}</span>
          <span class="muted mono"> · {job().model_id ?? job().model}</span>
        </span>
        <Show when={!done()}>
          <button class="btn btn-ghost btn-sm push" onClick={cancelRun} title={t("opt.progress.stop")}><Square size={14} aria-hidden="true" /> {t("common.cancel")}</button>
        </Show>
      </div>

      <dl class="kv">
        <dt>{t("opt.evaluations")}</dt>
        <dd class="mono">{latest()?.evaluations ?? optEvals().length} <span class="muted">/ {budget() || "—"} ({progressPercent()}%)</span></dd>
        <dt>{t("opt.goals")}</dt>
        <dd class="kv-left op-goals">
          <For each={spec()?.goals ?? []}>
            {(g) => (
              <span class="mono">{goalText(g)}</span>
            )}
          </For>
        </dd>
        <Show when={(optStart()?.ports?.length ?? 1) > 1}>
          <dt>{t("opt.drivenPorts")}</dt>
          <dd class="mono">
            {optStart()!.excite?.join(", ")}
            <span class="kv-sub">{t("opt.progress.drivenSub", { ports: optStart()!.ports!.join(", "), count: optStart()!.excite?.length ?? 1 })}</span>
          </dd>
        </Show>
        <dt>{t("opt.progress.best")}</dt>
        <dd class="mono">
          <Show when={best()} fallback="—">
            {Object.entries(best()!.params).map(([k, v]) => `${k} = ${v}`).join(", ")}
            <span class="kv-sub">
              {t("opt.progress.cost", { value: num(best()!.cost, 4) })}
              {/* Show every objective, including bandwidth and directivity, for the best point. */}
              {(spec()?.goals ?? []).map((g, i) => {
                const value = best()!.goals?.[i]?.value ?? (best()!.metrics ? goalValue(g, best()!.metrics) : null);
                const unit = g.kind === "f0" ? "GHz" : g.kind === "bw_min" ? "MHz" : g.kind === "dmax_min" ? "dBi" : "dB";
                return ` · ${goalText(g)}: ${num(value, 3)} ${unit}`;
              }).join("")}
              {" "}· {t("opt.progress.evaluationN", { n: best()!.index })}
            </span>
          </Show>
        </dd>
        <dt>{t("run.engine")}</dt>
        <dd class="mono">{(optEvals()[0]?.metrics.engine ?? job().engine ?? "cpu").toUpperCase()}</dd>
        <dt>{t("opt.progress.elapsed")}</dt>
        <dd class="mono">{seconds(latest()?.elapsed_s ?? elapsed())}{eta() != null ? ` · ${t("opt.progress.eta", { time: seconds(eta()!) })}` : ""}</dd>
      </dl>

      <div class="rp-chart">
        <Show when={series().length} fallback={<div class="rp-chart-empty">{t("opt.progress.chartEmpty")}</div>}>
          <LineChart
            ariaLabel={t("opt.progress.chartAria")}
            series={series()}
            xLabel={t("opt.progress.chartX")}
            yLabel={t("opt.progress.chartY")}
            yDomain={yDomain()}
            hlines={[{ y: 0, label: t("opt.progress.costOne") }]}
            xFormat={(v) => v.toFixed(0)}
            yFormat={(v) => v.toFixed(2)}
          />
        </Show>
      </div>

      <Show when={done()}>
        <Show
          when={job().status === "done"}
          fallback={
            <p class="status-block status-critical" role="alert">
              <CircleX size={14} aria-hidden="true" />
              <span>{job().status === "cancelled" ? t("opt.progress.cancelled") : job().status === "failed" ? t("opt.progress.failed") : job().status === "interrupted" ? t("opt.progress.interrupted") : t("opt.progress.ended", { status: job().status })} {job().error ?? ""}</span>
            </p>
          }
        >
          <p class={`status-block ${met() ? "status-good" : "status-warn"}`}>
            <Show when={met()} fallback={<TriangleAlert size={14} aria-hidden="true" />}><CircleCheck size={14} aria-hidden="true" /></Show>
            <span>
              {outcome()}
            </span>
          </p>
        </Show>
        <Show when={best()?.file}>
          <div class="cluster">
            <button class="btn btn-ghost btn-sm" onClick={openBest}><FolderOpen size={14} aria-hidden="true" /> {t("opt.openBest")}</button>
            <button class="btn btn-ghost btn-sm" onClick={saveBestRun} disabled={!done()}
              title={done() ? t("opt.saveBest.title") : t("opt.saveBest.notYet")}>
              <Download size={14} aria-hidden="true" /> {t("opt.saveBest")}
            </button>
            <Show when={optEvals().length > 1}>
              <button class="btn btn-ghost btn-sm" onClick={compareBestVsStart} title={t("opt.compare.title")}>
                <GitCompareArrows size={14} aria-hidden="true" /> {t("opt.compare")}
              </button>
            </Show>
          </div>
          <Show when={saveMessage()}><p role="status">{saveMessage()}</p></Show>
        </Show>
      </Show>

      <Show when={optEvals().length}>
        <div class="cluster">
          <button class="btn btn-ghost btn-sm" onClick={() => void exportHistory("csv")}>{t("opt.exportCsv")}</button>
          <button class="btn btn-ghost btn-sm" onClick={() => void exportHistory("json")}>{t("opt.exportJson")}</button>
        </div>
        <div class="rp-summary">
          <table class="table op-table">
            <caption>{t("opt.progress.caption")}</caption>
            <thead>
              <tr>
                <For each={cols()}>
                  {(c) => (
                    <th class="num" aria-sort={sort().key === c.key ? (sort().dir === 1 ? "ascending" : "descending") : "none"}>
                      <button class="rp-sort" onClick={() => toggle(c.key)}>
                        {c.label}
                        <Show when={sort().key === c.key}>
                          <Show when={sort().dir === 1} fallback={<ArrowDown size={12} aria-hidden="true" />}><ArrowUp size={12} aria-hidden="true" /></Show>
                        </Show>
                        <Show when={c.unit}><span class="th-unit">{c.unit}</span></Show>
                      </button>
                    </th>
                  )}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(e) => {
                  const open = () => e.file && openBundlePath(e.file, labelOf(e));
                  return (
                    <tr class="row-select" classList={{ selected: best()?.index === e.index }} tabindex={0}
                      aria-label={best()?.index === e.index ? t("opt.progress.rowBest", { n: e.index }) : t("opt.progress.row", { n: e.index })}
                      onClick={open} onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), open())}>
                      <For each={cols()}>{(c) => c.key === "status"
                        ? <td class="num" title={e.skipped ?? e.error}>{t(statusOf(e))}<Show when={e.skipped}><span class="rp-opt-skip muted">{e.skipped}</span></Show></td>
                        : <td class="num">{c.get(e) === null ? "—" : num(c.get(e), c.digits)}</td>}</For>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </section>
  );
}
