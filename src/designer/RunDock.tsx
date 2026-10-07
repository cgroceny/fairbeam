import DockResizeHandle from "../components/DockResizeHandle";
// The designer's bottom dock: Checks, Parameters, a run's live progress, the Runs tab (the design's
// runs keyed by their short labels A, B, ..., with the parameters that differ between them) and the
// log. The result views themselves open as main-area tabs (MainArea.tsx, ResultViews.tsx) from the
// navigation tree; runResults.ts shows the picked run in the 3D view.
import { createEffect, createMemo, createSignal, For, type JSX, Match, onCleanup, Show, Switch, untrack } from "solid-js";
import { ChevronDown, ChevronUp, CircleCheck, CircleX, FileText, Info, Square, TriangleAlert } from "lucide-solid";
import LineChart, { type Series } from "../charts/LineChart";
import { SERIES_COLORS, traces } from "../compare/series";
import { columnDecimals, compact, ghzText, num, seconds } from "../lib/format";
import { api, isTerminal, type Eta, type Phase } from "../runner/api";
import OptimizeProgress from "../runner/OptimizeProgress";
import { cancelJob, live, liveEnergy, liveInfo, liveLog, liveProgress, liveStats, stopping } from "../runner/store";
import { StatusBadge } from "../runner/status";
import { designDockTab, designJob, designJobId, designResult, designResultError, dockCancelTarget, failedResultLoad, followInDesigner, retryResultLoad, setDesignDockTab, type DesignDockTab } from "../runner/designRun";
import { activeRuns, jobName, RunQueue } from "../runner/RunQueue";
import type { Bundle } from "../types";
import { ChecksList } from "./DesignPane";
import ParametersDock from "./ParametersDock";
import { openParametersTab, showDesignDockTab } from "./dockState";
import { bottomDockCollapsed, setBottomDockCollapsed, toggleBottomDock } from "./layoutState";
import { SHORTCUTS } from "./shortcuts";
import { checks } from "./store";
import { resultFocus } from "./resultFocus";
import { activeMainResult } from "./mainTabsState";
import { MAX_COMPARE } from "./navModel";
import { bundleQuality, bundleRunMetrics, comparedRuns, designRunBundle, designRuns, ensureDesignRunBundles, runShortLabel, selectedRuns, selectRun, showView } from "./runResults";
import { differingParams, differs, madeLabels } from "./resultTabs";
import type { RunMetrics } from "./runSummary";
import { RunQualityBadge, RunQualityBanner } from "./RunQualityView";
import { createEtaPresenter } from "./etaPresentation";
import { slowHint, watchSpeed } from "./slowRun";
import { estimateTime } from "./meshStats";
import { bundle } from "../state";
import { fmt, t } from "../i18n";
import "../styles/designer-sim.css";

// labels are i18n keys
const PHASES: { id: Phase; label: string }[] = [
  { id: "queued", label: "runDock.phase.queued" },
  { id: "building", label: "runDock.phase.build" },
  { id: "setup", label: "runDock.phase.mesh" },
  { id: "running", label: "runDock.phase.fdtd" },
  { id: "postprocessing", label: "runDock.phase.postprocess" },
  { id: "exporting", label: "runDock.phase.export" },
];

function useNow(active: () => boolean) {
  const [now, setNow] = createSignal(Date.now() / 1000);
  createEffect(() => {
    if (!active()) return;
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    onCleanup(() => clearInterval(id));
  });
  return now;
}

// ------------------------------------------------------------------ live progress (compact)

function RunProgress() {
  const job = () => designJob()!;
  const done = () => isTerminal(job().status);
  const presentEta = createEtaPresenter();
  const now = useNow(() => !done());
  const elapsed = () => (job().started ? Math.max(0, (job().finished ?? now()) - job().started!) : null);
  const phaseIndex = () => {
    const i = PHASES.findIndex((p) => p.id === job().phase);
    return i >= 0 ? i : job().phase === "done" ? PHASES.length : -1;
  };
  const endDb = () => liveInfo().end_criteria_db ?? job().end_criteria_db ?? -40;
  /** Why the energy line is flat at the start: the excitation pulse is still running (the energy only
   * starts to fall once it ends), or it would not end before the limit at all. */
  const pulseNote = () => {
    const end = liveInfo().pulse_steps, limit = liveInfo().max_timesteps;
    if (!end) return null;
    if (limit && end >= limit) return t("progress.pulse.overLimit", { pulse: fmt.int(end), limit: fmt.int(limit) });
    const ts = liveProgress()?.timestep ?? 0;
    return ts < end ? t("progress.pulse.running", { n: fmt.int(end), left: fmt.int(end - ts) }) : null;
  };
  const fraction = () => {
    if (job().status === "done") return 1;
    const p = liveProgress();
    return Math.max(0, Math.min(1, p?.energy_fraction ?? p?.timestep_fraction ?? 0));
  };
  const eta = createMemo(() => {
    const p = liveProgress();
    return presentEta({ jobId: designJobId() ?? job().id, port: p?.port ?? liveInfo().port_run, eta: p?.eta ?? undefined });
  });
  // far slower than the pre-run estimate for a while: the machine is probably busy (slowRun.ts)
  const speed = () => liveProgress()?.speed_mcs ?? liveStats().speed_mcells_s;
  const [slowSince, setSlowSince] = createSignal<number | null>(null);
  const expected = createMemo(() => estimateTime(bundle(), job().engine ?? "cpu")?.mcps);
  createEffect(() => {
    const at = now();
    if (done() || job().phase !== "running") return void setSlowSince(null);
    const measured = speed();
    setSlowSince((since) => watchSpeed(since, at, measured, untrack(expected)));
  });
  const slow = () => !done() && slowHint(slowSince(), now());
  const etaRaw = (): Eta | undefined => liveProgress()?.eta ?? undefined;
  const etaBasis = (value: ReturnType<typeof eta>) => t(`runDock.eta.basis.${value.basis ?? "unknown"}`);
  const etaConfidence = (value: ReturnType<typeof eta>) => t(`runDock.eta.confidence.${value.confidence ?? "unknown"}`);
  const etaDetails = () => {
    const e = etaRaw();
    if (!e) return "";
    return [
      `basis=${e.basis ?? "unknown"}`,
      `confidence=${e.confidence ?? "unknown"}`,
      `points=${e.points}`,
      `timestep=${e.timestep}`,
      `remaining_timesteps=${e.remaining_timesteps ?? "—"}`,
      `target_timestep=${e.target_timestep ?? "—"}`,
      `eta_s=${e.eta_s ?? "—"}`,
      `job_eta_s=${e.job_eta_s ?? "—"}`,
      `limit_s=${e.limit_s ?? "—"}`,
    ].join("\n");
  };
  const etaTitle = () => etaDetails() || t("runDock.eta.waiting");
  const solverPhase = () => job().phase === "running";
  const etaStage = () => {
    if (job().phase === "postprocessing") return t("runDock.eta.postprocessing");
    if (job().phase === "exporting") return t("runDock.eta.exporting");
    if (!solverPhase()) return t("runDock.eta.preparing");
    return "";
  };
  const etaLabel = () => {
    if (etaStage()) return t("runDock.eta.label.status");
    const value = eta();
    if (value.state === "timestep-bound") return t("runDock.eta.label.limit");
    if (value.jobSeconds !== undefined) return t("runDock.eta.label.job");
    return t("runDock.eta.label.convergence");
  };
  const etaValue = () => {
    const stage = etaStage();
    if (stage) return stage;
    const value = eta();
    if (value.state === "waiting") return t("runDock.eta.waiting");
    if (value.state === "early") return t("runDock.eta.approx", { time: seconds(value.rawSeconds) });
    if (value.state === "range" && value.rangeSeconds) return t("runDock.eta.range", {
      from: seconds(value.rangeSeconds[0]), to: seconds(value.rangeSeconds[1]),
    });
    if (value.state === "timestep-bound") {
      const limit = value.limitSeconds ?? value.rawSeconds;
      return limit === undefined ? t("runDock.eta.waiting") : t("runDock.eta.boundValue", { time: seconds(limit) });
    }
    if (value.state === "converged" && value.jobSeconds !== undefined && value.jobSeconds > 0) {
      return t("runDock.eta.approx", { time: seconds(value.jobSeconds) });
    }
    return t("runDock.eta.reached");
  };
  const etaNote = () => {
    const stage = etaStage();
    if (stage) return "";
    const value = eta();
    if (value.state === "waiting") return t("runDock.eta.waitingNote");
    if (value.state === "early") return t((liveInfo().port_total ?? 1) > 1 ? "runDock.eta.earlyPortNote" : "runDock.eta.earlyNote", {
      count: value.points ?? 0, basis: etaBasis(value), confidence: etaConfidence(value),
    });
    if (value.state === "range") return value.jobSeconds !== undefined
      ? t("runDock.eta.jobRangeNote", { count: value.portsRemaining ?? 0, basis: etaBasis(value), confidence: etaConfidence(value) })
      : t((liveInfo().port_total ?? 1) > 1 ? "runDock.eta.portOnlyNote" : "runDock.eta.rangeNote", {
        basis: etaBasis(value), confidence: etaConfidence(value),
      });
    if (value.state === "timestep-bound") return t((liveInfo().port_total ?? 1) > 1 ? "runDock.eta.capPortsNote" : "runDock.eta.boundNote");
    if (value.state === "converged" && value.jobSeconds !== undefined && value.jobSeconds > 0) {
      return t("runDock.eta.portDoneNote", { count: value.portsRemaining ?? 0 });
    }
    return t("runDock.eta.reachedNote");
  };
  const etaHasSeparateLimit = () => solverPhase() && eta().limitSeconds !== undefined && eta().state !== "timestep-bound";
  // after the run, a bound (the energy fell below the criterion after the last logged sample)
  // replaces a missing or stale live sample
  const energy = () => {
    const st = liveStats();
    if (done() && st.final_energy_db === undefined && st.final_energy_bound_db !== undefined) return `≤ ${num(st.final_energy_bound_db, 1)}`;
    return num(liveProgress()?.energy_db ?? st.final_energy_db, 1);
  };
  const series = createMemo<Series[]>(() => {
    const pts = liveEnergy();
    if (!pts.length) return [];
    const last = pts[pts.length - 1].ts;
    const x = [0, ...pts.map((p) => p.ts), last * 1.15 + 1];
    const y = [NaN, ...pts.map((p) => p.db), NaN];
    return [{ id: "energy", label: t("runDock.fieldEnergy"), color: "--al-series-1", x, y }];
  });
  const stderrTail = () => {
    for (let i = live.events.length - 1; i >= 0; i--) {
      const e = live.events[i];
      if (e.type === "status" && e.stderr_tail?.length) return e.stderr_tail;
    }
    return [];
  };
  return (
    <div class="rdk-run" aria-live="polite" aria-busy={!done()}>
      <div class="rdk-run-main">
        <div class="cluster-sm rdk-run-head">
          <StatusBadge status={job().status} />
          <span class="mono">{job().label ?? job().model_id ?? job().model}</span>
          <span class="muted">· {job().engine ?? "cpu"}{job().engine === "gpu" ? "" : `, ${t("runDock.threads", { count: liveInfo().threads ?? job().threads })}`}</span>
          <Show when={!done()}>
            <button class="btn btn-ghost btn-sm rdk-push" onClick={() => void cancelJob(job().id)} disabled={stopping().has(job().id)} title={t("runDock.stop.title")}>
              <Square size={13} aria-hidden="true" /> {stopping().has(job().id) ? t("runQueue.stopping") : t("common.cancel")}
            </button>
          </Show>
        </div>
        {/* first, where the dock's small height still shows it: a finished run that did not converge */}
        <Show when={job().status === "done" && designResult()}>{(r) => <RunQualityBanner file={r().file} b={r().bundle} />}</Show>
        <ol class="rdk-phases" aria-label={t("runDock.phases")}>
          <For each={PHASES}>{(p, i) => (
            <li classList={{ "rdk-ph-done": i() < phaseIndex(), "rdk-ph-now": i() === phaseIndex() && !done() }}
              aria-current={i() === phaseIndex() && !done() ? "step" : undefined}>
              {p.id === "running" && (liveInfo().port_total ?? 1) > 1 ? `FDTD ${liveInfo().port_run}/${liveInfo().port_total}` : t(p.label)}
            </li>
          )}</For>
        </ol>
        <div class="rdk-progress" role="progressbar" aria-label={t("runDock.progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction() * 100)}>
          <span style={{ width: `${fraction() * 100}%` }} />
        </div>
        <Show when={slow()}>
          <p class="status-block status-warn rdk-slow" role="status">
            <TriangleAlert size={14} aria-hidden="true" />
            <span>{t("runDock.slow", { speed: num(speed() ?? 0, 0), expected: num(expected() ?? 0, 0) })}</span>
          </p>
        </Show>
        <Show when={!done() && pulseNote()}>
          <p class="status-block rdk-pulse" role="status">
            <Info size={14} aria-hidden="true" />
            <span><strong>{t("progress.pulse")}</strong> {pulseNote()}</span>
          </p>
        </Show>
        <dl class="rdk-stats">
          <div><dt>{t("runDock.stat.timestep")}</dt><dd class="mono">{(() => { const n = liveProgress()?.timestep ?? liveStats().timesteps; return n === undefined || n === null ? "—" : fmt.int(n); })()}<Show when={liveInfo().max_timesteps}><span class="muted"> / {fmt.int(liveInfo().max_timesteps!)}</span></Show></dd></div>
          <div><dt>{t("runDock.stat.speed")}</dt><dd class="mono">{num(liveProgress()?.speed_mcs ?? liveStats().speed_mcells_s, 0)} MC/s</dd></div>
          <div><dt>{t("runDock.stat.energy")}</dt><dd class="mono">{energy()} / {endDb()} dB</dd></div>
          <div><dt>{t("runDock.stat.elapsed")}</dt><dd class="mono">{seconds(elapsed())}</dd></div>
          <Show when={!done()}>
            <div class="rdk-eta-stat">
              <dt>{etaLabel()}</dt>
              <dd class="mono" title={etaTitle()}>{etaValue()}</dd>
              <Show when={etaNote()}><dd class="note rdk-eta-note">{etaNote()}</dd></Show>
              <Show when={etaDetails()}>
                <dd><details class="rdk-eta-details">
                  <summary>{t("runDock.eta.details")}</summary>
                  <pre class="code">{etaDetails()}</pre>
                </details></dd>
              </Show>
            </div>
            <Show when={etaHasSeparateLimit()}>
              <div>
                <dt>{t("runDock.eta.label.limit")}</dt>
                <dd class="mono" title={`limit_s=${eta().limitSeconds}`}>{t("runDock.eta.boundValue", { time: seconds(eta().limitSeconds) })}</dd>
                <dd class="note rdk-eta-note">{t((liveInfo().port_total ?? 1) > 1 ? "runDock.eta.capPortsNote" : "runDock.eta.capNote")}</dd>
              </div>
            </Show>
          </Show>
          <Show when={liveInfo().cells}><div><dt>{t("runDock.stat.grid")}</dt><dd class="mono">{t("runDock.cells", { cells: compact(liveInfo().cells) })}</dd></div></Show>
        </dl>
        <Show when={job().status === "done"}>
          <p class="status-block" classList={{ "status-good": liveStats().converged !== false, "status-warn": liveStats().converged === false }}>
            <Show when={liveStats().converged !== false} fallback={<TriangleAlert size={14} aria-hidden="true" />}><CircleCheck size={14} aria-hidden="true" /></Show>
            <span>
              {t(liveStats().converged === false ? "runDock.timestepLimit" : "runDock.converged")} {seconds(job().duration_s)}.
              <Show when={designResult()}> <button class="linklike" onClick={() => showView("sparams", undefined, "main")}>{t("runDock.showSparams")}</button></Show>
            </span>
          </p>
        </Show>
        <Show when={job().status === "failed" || job().status === "interrupted"}>
          <div class="status-block status-critical" role="alert">
            <CircleX size={14} aria-hidden="true" />
            <div>
              <p>{t(job().status === "failed" ? "runDock.failed" : "runDock.interrupted")}{job().error ? `: ${job().error}` : "."}</p>
              <Show when={stderrTail().length}><pre class="code rdk-stderr">{stderrTail().slice(-6).join("\n")}</pre></Show>
            </div>
          </div>
        </Show>
      </div>
      <div class="rdk-run-chart">
        <Show when={series().length} fallback={<div class="panel-empty">{done()
          ? t("runDock.energy.noSample")
          : t("runDock.energy.waiting")}</div>}>
          <LineChart ariaLabel={t("runDock.energy.chart")} series={series()} xLabel={t("runDock.stat.timestep")} yLabel={t("runDock.energy.axis")}
            yDomain={[Math.floor(Math.min(endDb() - 10, ...liveEnergy().map((p) => p.db)) / 10) * 10, 0]}
            hlines={[{ y: endDb(), label: t("runDock.energy.end", { db: endDb() }) }]} xFormat={(v) => compact(v)} yFormat={(v) => v.toFixed(0)} />
        </Show>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the Runs tab

/** The Runs tab: the design's runs keyed by their short labels (A, B, ...; the legends of the result
 * tabs use them). One row per run, oldest (A) first: the label with its trace colour while it is
 * plotted, the run's name and when it was made, one column per parameter that differs between the
 * runs, the engine when it differs, and the solver time. The label toggles the run in the comparison;
 * the row (its name) makes it the shown run. */
function RunsTable() {
  // the runs' bundles are read once, when the table is first shown (runResults.ts)
  createEffect(() => ensureDesignRunBundles());
  const [note, setNote] = createSignal("");
  // a result tab in front shows the picked run(s); with the 3D view in front the run shows there
  const where = () => (activeMainResult() ? "main" as const : "keep" as const);
  const toggle = (file: string) => setNote(selectRun(file, true, where()) ? "" : t("tree.note.compareFull", { max: MAX_COMPARE }));
  const choose = (file: string) => { setNote(""); selectRun(file, false, where()); };
  // the plotted runs and their colours (traces() leaves out a run without port results)
  const colours = createMemo(() => {
    const current = designResult();
    if (!current) return new Map<string, string>();
    const runs = comparedRuns();
    const files = new Map<Bundle, string>([[current.bundle, current.file], ...runs.map((c) => [c.bundle, c.file] as [Bundle, string])]);
    return new Map(traces(current.bundle, runs.map((c) => c.bundle)).map((tr, i) => [files.get(tr.bundle) ?? "", SERIES_COLORS[i]]));
  });
  const plotted = () => colours().size;
  const shownFile = () => resultFocus()?.file ?? designResult()?.file;
  // oldest (A) first; only runs whose bundle has been read (the others follow once it arrives)
  const rows = createMemo(() => designRuns().flatMap((r) => {
    const bundle = designRunBundle(r.file);
    return bundle ? [{ file: r.file, label: r.label, letter: runShortLabel(r.file), bundle }] : [];
  }).reverse());
  const made = createMemo(() => madeLabels(rows().map((r) => r.bundle.created)));
  const columns = createMemo(() => differingParams(rows().map((r) => r.bundle.model)));
  // the headline numbers: a column shows when any run has the value (a run without a far field has no Dmax)
  const metrics = createMemo(() => rows().map((r) => bundleRunMetrics(r.bundle)));
  const has = (pick: (m: RunMetrics) => unknown) => metrics().some((m) => m && pick(m) != null);
  const engineOf = (b: Bundle) => b.run?.engine ?? b.solver.engine;
  const engines = () => differs(rows().map((r) => engineOf(r.bundle)));
  // a parameter column in the UI language's decimal separator, with one number of decimals for the column
  const paramValue = (b: Bundle, key: string) => b.model.params.find((v) => v.key === key)?.value;
  const paramDigits = createMemo(() => new Map(columns().map((p) => [p.key, columnDecimals(rows().map((r) => paramValue(r.bundle, p.key)))])));
  const paramText = (b: Bundle, key: string) => {
    const v = paramValue(b, key);
    return typeof v === "number" ? fmt.fixed(v, paramDigits().get(key) ?? 0) : v === undefined || v === null ? "—" : String(v);
  };
  const solverTime = (b: Bundle) => seconds(b.run?.solver_time_s ?? b.run?.wall_time_total_s ?? b.run?.wall_time_s);
  return (
    <div class="rdk-runs-tab">
      <Show when={rows().length} fallback={<div class="panel-empty">{t(designRuns().length ? "runDock.runs.reading" : "runDock.runs.none")}</div>}>
        <p class="rdk-key-note">
          {plotted() > 1 ? t("runDock.runs.comparing", { count: plotted() }) : t("runDock.runs.one")} {t("runDock.runs.help")}
          <Show when={rows().length > 1 && !columns().length}> {t("runDock.runs.noDiff")}</Show>
          {" "}<button type="button" class="linklike" onClick={() => showView("summary", undefined, "main")}>{t("runDock.runs.openSummary")}</button>
        </p>
        <div class="rdk-runs-scroll" tabIndex={0} role="group" aria-label={t("runDock.runs.label")}>
          <table class="rdk-runs">
            <caption class="visually-hidden">{t("runDock.runs.caption")}</caption>
            <thead><tr>
              <th scope="col">{t("runDock.runs.col.run")}</th>
              <th scope="col">{t("runDock.runs.col.name")}</th>
              <th scope="col" class="num" title={t("summary.f0.title")}>{t("runDock.runs.col.f0")}</th>
              <th scope="col" class="num">{t("runDock.runs.col.s11")}</th>
              <th scope="col" class="num" title={t("summary.bandwidth.title")}>{t("runDock.runs.col.bw")}</th>
              <Show when={has((m) => m.farfield)}><th scope="col" class="num">{t("runDock.runs.col.dmax")}</th></Show>
              <Show when={has((m) => m.totalEff)}><th scope="col" class="num" title={t("summary.totalEff.title")}>{t("runDock.runs.col.eff")}</th></Show>
              <th scope="col">{t("runDock.runs.col.made")}</th>
              <For each={columns()}>{(p) => <th scope="col" class="num">{p.key}{p.unit ? ` (${p.unit})` : ""}</th>}</For>
              <Show when={engines()}><th scope="col">{t("runDock.runs.col.engine")}</th></Show>
              <th scope="col">{t("runDock.runs.col.solverTime")}</th>
            </tr></thead>
            <tbody><For each={rows()}>{(row, i) => {
              const colour = () => colours().get(row.file);
              const on = () => selectedRuns().includes(row.file);
              const current = () => shownFile() === row.file;
              const m = () => metrics()[i()];
              return (
                <tr classList={{ "rdk-runs-on": on(), "rdk-runs-current": current() }} aria-current={current() ? "true" : undefined}
                  onClick={(e) => { if (!(e.target as HTMLElement).closest("button")) choose(row.file); }}>
                  <th scope="row">
                    <button type="button" class="rdk-run-btn" aria-pressed={on()} aria-label={t("runDock.runs.toggle", { letter: row.letter })}
                      title={t(on() ? "runDock.runs.toggle.remove" : "runDock.runs.toggle.add", { letter: row.letter, label: row.label })} onClick={() => toggle(row.file)}>
                      <span class="rdk-run-chip" classList={{ "rdk-run-chip-off": !colour() }} style={colour() ? { background: `var(${colour()})` } : undefined} aria-hidden="true" />
                      {row.letter}
                    </button>
                  </th>
                  <td class="rdk-runs-name">
                    <button type="button" class="rdk-run-name" aria-current={current() ? "true" : undefined} title={t("runDock.runs.show", { file: row.file })} onClick={() => choose(row.file)}>{row.label}</button>
                    <RunQualityBadge q={bundleQuality(row.bundle)} />
                  </td>
                  <td class="num" title={m()?.noResonance ? t("summary.noResonance") : undefined}>{m()?.noResonance ? t("summary.noResonanceShort") : m()?.f0 != null ? ghzText(m()!.f0! / 1e9) : "\u2014"}</td>
                  <td class="num">{m()?.s11MinDb != null ? num(m()!.s11MinDb!, 1).replace(/^-/, "\u2212") : "\u2014"}</td>
                  <td class="num">{m()?.bwHz != null ? num(m()!.bwHz! / 1e6, 0) : "\u2014"}</td>
                  <Show when={has((x) => x.farfield)}><td class="num">{m()?.farfield ? num(m()!.farfield!.dmaxDbi, 2) : "\u2014"}</td></Show>
                  <Show when={has((x) => x.totalEff)}><td class="num">{m()?.totalEff != null ? num(m()!.totalEff! * 100, 1) : "\u2014"}</td></Show>
                  <td>{made()[i()]}</td>
                  <For each={columns()}>{(p) => <td class="num">{paramText(row.bundle, p.key)}</td>}</For>
                  <Show when={engines()}><td>{engineOf(row.bundle)}</td></Show>
                  <td>{solverTime(row.bundle)}</td>
                </tr>
              );
            }}</For></tbody>
          </table>
        </div>
      </Show>
      <p class="rdk-key-note" role="status">{note()}</p>
    </div>
  );
}

/** The live log of the designer's run; for an earlier run, the end of its log from the bundle. */
function RunLog() {
  let box: HTMLPreElement | undefined;
  const active = () => !!designJob() && !isTerminal(designJob()!.status);
  const mine = () => !!designJob() && (active() || !designResult() || designResult()?.jobId === designJobId());
  const logId = () => active() ? designJobId() : designResult()?.jobId ?? designJobId();
  const tail = () => designResult()?.bundle.run?.log_tail ?? [];
  createEffect(() => {
    liveLog().length;
    if (box) box.scrollTop = box.scrollHeight;
  });
  return (
    <div class="rdk-log">
      <Show when={mine()} fallback={
        <Show when={tail().length} fallback={<div class="panel-empty">{t("runDock.log.none")}</div>}>
          <pre class="code rdk-log-body">{tail().join("\n")}</pre>
        </Show>
      }>
        <pre class="code rdk-log-body" ref={box}>
          <For each={liveLog()}>{(l) => <span classList={{ "rp-log-err": l.stream === "stderr" }}>{l.line + "\n"}</span>}</For>
        </pre>
      </Show>
      <Show when={logId()}>
        <a class="rp-log-link rdk-log-link" href={api.logUrl(logId()!)} target="_blank" rel="noopener">
          <FileText size={13} aria-hidden="true" /> {t("runDock.log.full")}
        </a>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------------ the dock

export default function RunDock() {
  const hasJob = () => !!designJob();
  const running = () => hasJob() && !isTerminal(designJob()!.status);
  const stopTarget = dockCancelTarget;
  const hasRuns = () => !!designResult() || designRuns().length > 0;
  const tabs = createMemo(() => {
    // labels are functions, so a tab follows the UI language without rebuilding the list
    const list: { id: DesignDockTab; label: () => JSX.Element }[] = [{ id: "checks", label: () => <ChecksLabel /> }, { id: "parameters", label: () => t("dock.tab.parameters") }];
    if (hasJob()) list.push({ id: "run", label: () => t(running() ? "dock.tab.runLive" : "dock.tab.run") });
    if (hasRuns()) list.push({ id: "runs", label: () => t("dock.tab.runs") });
    // the server's queue, whoever filled it: a run started from a terminal or another window can be
    // followed, stopped or taken out of the queue from here (#8)
    if (activeRuns().length) list.push({ id: "queue", label: () => t("dock.tab.queue", { count: activeRuns().length }) });
    if (hasJob() || designResult()) list.push({ id: "log", label: () => t("dock.tab.log") });
    return list;
  });
  // a tab that went away (result cleared, another job attached) falls back to the runs, else to
  // Checks, without opening a collapsed dock
  createEffect(() => {
    if (!tabs().some((tab) => tab.id === designDockTab())) showDesignDockTab(hasRuns() ? "runs" : "checks");
  });
  const choose = (id: DesignDockTab) => {
    if (id === "parameters") openParametersTab();
    else setDesignDockTab(id);
  };
  const onKey: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (e) => {
    const list = tabs();
    const i = list.findIndex((tab) => tab.id === designDockTab());
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const tab = list[(next + list.length) % list.length];
    choose(tab.id);
    (e.currentTarget.querySelector(`[data-tab="${tab.id}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <section class="dw-dock rdk" aria-label={t("dock.label")} tabIndex={0}>
      <DockResizeHandle />
      <Show when={tabs().length > 1} fallback={<ChecksList />}>
        <div class="dock-bar rdk-bar-top">
          <div class="tabs" role="tablist" aria-label={t("dock.tabs")} onKeyDown={onKey}>
            <For each={tabs()}>{(tab) => (
              <button role="tab" class="tab" data-tab={tab.id} aria-selected={designDockTab() === tab.id} tabindex={designDockTab() === tab.id ? 0 : -1}
                onClick={() => { choose(tab.id); setBottomDockCollapsed(false); }}>{tab.label()}</button>
            )}</For>
          </div>
          <div class="dock-tools">
            {/* the Run tab has its own Cancel beside the job's name: one button per view, not two (unless the
                dock is collapsed). It stops the run the dock shows, else the run the window follows, else the
                server's running run, whoever started it (#8); a run that is not the dock's is named on it */}
            <Show when={stopTarget() && (designDockTab() !== "run" || bottomDockCollapsed() || stopTarget() !== designJob())}>
              <button class="btn btn-ghost btn-sm" data-dock-cancel={stopTarget()!.id} onClick={() => void cancelJob(stopTarget()!.id)}
                disabled={stopping().has(stopTarget()!.id)}
                title={stopTarget() === designJob() ? t("runDock.stop.title") : t("dock.stopRun.title", { name: jobName(stopTarget()!) })}>
                <Square size={13} aria-hidden="true" /> {stopping().has(stopTarget()!.id) ? t("runQueue.stopping")
                  : stopTarget() === designJob() ? t("dock.cancelRun")
                    : <span class="dock-stop-name">{t("dock.stopOther", { name: jobName(stopTarget()!) })}</span>}
              </button>
            </Show>
            <button class="icon-btn icon-btn-sm rdk-collapse" type="button" onClick={toggleBottomDock} aria-expanded={!bottomDockCollapsed()}
              aria-label={t(bottomDockCollapsed() ? "dock.expand" : "dock.collapse")}
              title={t(bottomDockCollapsed() ? "dock.expand.title" : "dock.collapse.title", { key: SHORTCUTS.dock.key })}>
              <Show when={bottomDockCollapsed()} fallback={<ChevronDown size={14} aria-hidden="true" />}><ChevronUp size={14} aria-hidden="true" /></Show>
            </button>
          </div>
        </div>
        <div class="dock-body rdk-body">
          <Show when={designResultError() && designDockTab() !== "checks"}>
            <p class="status-block status-critical" role="alert"><CircleX size={14} aria-hidden="true" /><span>{designResultError()}</span><Show when={failedResultLoad()}><button class="btn btn-ghost btn-sm" onClick={retryResultLoad}>{t("common.retry")}</button></Show></p>
          </Show>
          <Switch>
            <Match when={designDockTab() === "parameters"}><ParametersDock /></Match>
            <Match when={designDockTab() === "checks"}><ChecksList /></Match>
            <Match when={designDockTab() === "run" && hasJob()}>
              {designJob()!.kind === "optimize" ? <OptimizeProgress /> : <RunProgress />}
            </Match>
            <Match when={designDockTab() === "runs"}><RunsTable /></Match>
            <Match when={designDockTab() === "queue"}><RunQueue followed={designJobId()} onFollow={(j) => followInDesigner(j)} /></Match>
            <Match when={designDockTab() === "log"}><RunLog /></Match>
          </Switch>
        </div>
      </Show>
    </section>
  );
}

function ChecksLabel() {
  const errs = () => checks().filter((c) => c.severity === "error").length;
  const warns = () => checks().filter((c) => c.severity === "warning").length;
  const notes = () => checks().filter((c) => c.severity === "info").length;
  // The badge shows the most severe kind; notes (nonblocking) get a neutral count only when alone.
  // The count is spoken from hidden text: aria-label on a plain span is not reliably announced.
  return (
    <span class="rdk-checks-tab">
      {t("dock.tab.checks")}
      <Show when={errs()}><span class="rdk-count rdk-count-bad" aria-hidden="true">{errs()}</span><span class="visually-hidden">{t("status.checks.errors", { count: errs() })}</span></Show>
      <Show when={!errs() && warns()}><span class="rdk-count rdk-count-warn" aria-hidden="true">{warns()}</span><span class="visually-hidden">{t("status.checks.warnings", { count: warns() })}</span></Show>
      <Show when={!errs() && !warns() && notes()}>
        <span class="rdk-count" style={{ background: "var(--al-surface-2)", color: "var(--al-text-2)" }} aria-hidden="true">{notes()}</span>
        <span class="visually-hidden">{t("status.checks.notes", { count: notes() })}</span>
      </Show>
    </span>
  );
}
