import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Check, CircleCheck, CircleX, FileText, FolderOpen, Square, TriangleAlert } from "lucide-solid";
import LineChart, { type Series } from "../charts/LineChart";
import { compact, num, seconds } from "../lib/format";
import { isTerminal, type Phase } from "./api";
import { cancelRun, jobs, live, liveEnergy, liveInfo, liveLog, liveProgress, liveStats, openResult } from "./store";
import { StatusBadge, paramSummary } from "./status";
import { api } from "./api";
import { cancelSweep } from "./sweep";
import { fmt, t } from "../i18n";

/** label: an i18n key */
const STEPS: { id: Phase; label: string }[] = [
  { id: "queued", label: "progress.status.queued" },
  { id: "building", label: "progress.step.building" },
  { id: "setup", label: "progress.step.setup" },
  { id: "running", label: "progress.step.running" },
  { id: "postprocessing", label: "progress.step.postprocessing" },
  { id: "exporting", label: "progress.step.exporting" },
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

function etaText(): { value: string; note: string } {
  const p = liveProgress();
  const eta = p?.eta;
  if (!eta || eta.eta_s === undefined || eta.eta_s === null) return { value: "—", note: t("progress.eta.needSamples") };
  if (eta.basis === "converged") return { value: "0 s", note: t("progress.eta.reached") };
  if (eta.basis === "timestep-limit") return { value: `≤ ${seconds(eta.eta_s)}`, note: t("progress.eta.bounded") };
  const rough = eta.confidence === "low";
  if (eta.job_eta_s !== undefined && eta.ports_remaining) {
    return { value: `~ ${seconds(eta.job_eta_s)}`, note: t("progress.eta.ports", { time: seconds(eta.eta_s), count: eta.ports_remaining }) };
  }
  return { value: `~ ${seconds(eta.eta_s)}`, note: rough ? t("progress.eta.rough") : t("progress.eta.decay") };
}

export default function ProgressCard() {
  const job = () => live.job!;
  const done = () => isTerminal(job().status);
  const now = useNow(() => !done());
  const elapsed = () => {
    const j = job();
    if (!j.started) return null;
    return Math.max(0, (j.finished ?? now()) - j.started);
  };
  const stepIndex = () => {
    const ph = job().phase;
    const i = STEPS.findIndex((s) => s.id === ph);
    if (i >= 0) return i;
    if (ph === "done") return STEPS.length;
    // failed / cancelled / interrupted: the last phase reached before that
    const phases = live.events.filter((e) => e.type === "phase").map((e) => (e as { phase: Phase }).phase);
    for (let k = phases.length - 1; k >= 0; k--) {
      const idx = STEPS.findIndex((s) => s.id === phases[k]);
      if (idx >= 0) return idx;
    }
    return 0;
  };
  const endDb = () => liveInfo().end_criteria_db ?? job().end_criteria_db ?? -40;
  /** Why the energy line is flat at the start: the excitation pulse is still running (the energy only
   * starts to fall once it ends), or it would not end before the limit at all. */
  const pulseNote = () => {
    const end = liveInfo().pulse_steps, limit = liveInfo().max_timesteps;
    const ts = liveProgress()?.timestep ?? 0;
    if (!end) return null;
    if (limit && end >= limit) return t("progress.pulse.overLimit", { pulse: fmt.int(end), limit: fmt.int(limit) });
    return ts < end ? t("progress.pulse.running", { n: fmt.int(end), left: fmt.int(end - ts) }) : null;
  };
  const sweepProgress = () => {
    const sw = job().sweep;
    if (!sw) return null;
    const matching = jobs().filter((j) => j.sweep?.id === sw.id);
    return { sw, done: matching.filter((j) => j.status === "done").length };
  };

  // Energy vs timestep. LineChart takes its x range from the first and last x and skips NaN
  // values, so a NaN point at timestep 0 starts the axis at 0 and a trailing NaN point leaves room
  // right of the newest sample (up to the estimated end when there is one). A single sample is
  // doubled so its zero-length segment renders as a dot.
  const series = createMemo<Series[]>(() => {
    const pts = liveEnergy();
    if (!pts.length) return [];
    const last = pts[pts.length - 1].ts;
    const target = liveProgress()?.eta?.target_timestep;
    const end = Math.max(last * 1.15, !done() && target ? Math.min(target, last * 3) : 0);
    const x = [0, ...pts.map((p) => p.ts)];
    const y = [NaN, ...pts.map((p) => p.db)];
    if (pts.length === 1) {
      x.push(last * 1.0001);
      y.push(pts[0].db);
    }
    x.push(end);
    y.push(NaN);
    return [{ id: "energy", label: t("progress.fieldEnergy"), color: "--al-series-1", x, y }];
  });
  const yDomain = createMemo<[number, number]>(() => {
    const lo = Math.min(endDb() - 10, ...liveEnergy().map((p) => p.db));
    return [Math.floor(lo / 10) * 10, 0];
  });

  let logBox: HTMLPreElement | undefined;
  const [logOpen, setLogOpen] = createSignal(false);
  createEffect(() => {
    liveLog().length;
    if (logOpen() && logBox) logBox.scrollTop = logBox.scrollHeight;
  });
  createEffect(() => {
    if (job().status === "failed") setLogOpen(true);
  });

  const stderrTail = () => {
    for (let i = live.events.length - 1; i >= 0; i--) {
      const e = live.events[i];
      if (e.type === "status" && e.stderr_tail?.length) return e.stderr_tail;
    }
    return [];
  };

  return (
    <section class="section rp-progress stack" aria-label={t("progress.aria")} aria-live="polite" aria-busy={!done()}>
      <div class="cluster rp-progress-head">
        <StatusBadge status={job().status} />
        <span class="rp-job-title" title={job().id}>
          <Show
            when={job().sweep}
            fallback={<><span class="mono">{job().label ?? job().model_id ?? job().model}</span><span class="muted"> {paramSummary(job())}</span></>}
          >
            {(sw) => (
              <>
                <span>{sw().name}</span>
                <span class="muted mono"> · {Object.entries(sw().values).map(([k, v]) => `${k}=${v}`).join(", ")} · {((sw() as { sequence_name?: string }).sequence_name ?? t("progress.runN", { n: (sw() as { sequence_index?: number }).sequence_index ?? sw().index + 1 }))} · {t("progress.sweepDone", { done: sweepProgress()?.done ?? 0, total: sw().total })}</span>
              </>
            )}
          </Show>
        </span>
        <Show when={!done()}>
          <button class="btn btn-ghost btn-sm push" onClick={() => job().sweep ? cancelSweep(job().sweep!.id) : cancelRun()} title={job().sweep ? t("progress.stopSweepTitle") : t("progress.stopRunTitle")}>
            <Square size={14} aria-hidden="true" /> {job().sweep ? t("progress.stopSweep") : t("common.cancel")}
          </button>
        </Show>
      </div>

      <ol class="rp-steps" aria-label={t("progress.phases")}>
        <For each={STEPS}>
          {(s, i) => {
            const state = () => (i() < stepIndex() ? "done" : i() === stepIndex() ? (done() && job().status !== "done" ? "stopped" : "current") : "todo");
            return (
              <li class={`rp-step rp-step-${state()}`} aria-current={state() === "current" ? "step" : undefined}>
                <span class="rp-step-mark" aria-hidden="true">
                  <Show when={state() === "done"}><Check size={10} /></Show>
                </span>
                <span class="rp-step-label">{s.id === "running" && (liveInfo().port_total ?? 1) > 1 ? t("progress.step.runningPort", { run: liveInfo().port_run, total: liveInfo().port_total }) : t(s.label)}</span>
                <span class="visually-hidden">{state() === "done" ? ` (${t("progress.state.done")})` : state() === "current" ? ` (${t("progress.state.current")})` : state() === "stopped" ? ` (${t("progress.state.stopped")})` : ""}</span>
              </li>
            );
          }}
        </For>
      </ol>

      <dl class="kv rp-stats">
        <dt>{t("results.mesh.timestep")}</dt>
        <dd class="mono">
          {(() => { const n = liveProgress()?.timestep ?? liveStats().timesteps; return n === undefined || n === null ? "—" : fmt.int(n); })()}
          <Show when={liveInfo().max_timesteps}>
            <span class="muted"> / {t("progress.max", { n: fmt.int(liveInfo().max_timesteps!) })}</span>
          </Show>
        </dd>
        <dt>{t("spec.throughput")}</dt>
        <dd class="mono">{num(liveProgress()?.speed_mcs ?? liveStats().speed_mcells_s, 1)} MC/s</dd>
        <dt>{t("progress.fieldEnergy")}</dt>
        <dd class="mono">
          {/* once the run reports its summary, a bound (energy reached the criterion after the last
              logged sample) replaces the stale live sample */}
          {liveStats().final_energy_db === undefined && liveStats().final_energy_bound_db !== undefined
            ? `≤ ${num(liveStats().final_energy_bound_db, 1)}`
            : num(liveProgress()?.energy_db ?? liveStats().final_energy_db, 1)}{" "}dB
          <span class="muted"> · {t("progress.target", { db: endDb() })}</span>
        </dd>
        <Show when={!done() && pulseNote()}>
          <dt>{t("progress.pulse")}</dt>
          <dd class="rp-pulse-note" role="status">{pulseNote()}</dd>
        </Show>
        <dt>{t("progress.elapsed")}</dt>
        <dd class="mono">{seconds(elapsed())}</dd>
        <Show when={!done()}>
          <dt>{t("progress.remaining")}</dt>
          <dd>
            <span class="mono">{etaText().value}</span>
            <span class="rp-eta-note">{etaText().note}</span>
          </dd>
        </Show>
        <Show when={liveInfo().grid}>
          <dt>{t("spec.grid")}</dt>
          <dd class="mono">{liveInfo().grid!.join(" × ")} · {t("progress.cells", { cells: compact(liveInfo().cells) })}</dd>
        </Show>
        <dt>{t("progress.threads")}</dt>
        <dd class="mono">{liveInfo().threads ?? job().threads}</dd>
      </dl>

      <Show when={series().length || !done()}>
        <div class="rp-chart">
          <Show
            when={series().length}
            fallback={<div class="rp-chart-empty">{t("progress.chartEmpty")}</div>}
          >
            <LineChart
              ariaLabel={t("progress.chartAria")}
              series={series()}
              xLabel={t("results.mesh.timestep")}
              yLabel={t("progress.energyDb")}
              yDomain={yDomain()}
              hlines={[{ y: endDb(), label: t("progress.endLine", { db: endDb() }) }]}
              xFormat={(v) => compact(v)}
              yFormat={(v) => v.toFixed(1)}
            />
          </Show>
          <Show when={liveEnergy().length === 1}>
            <p class="chart-note">{done() ? t("progress.oneSampleDone") : t("progress.oneSample")}</p>
          </Show>
        </div>
      </Show>

      <Show when={job().status === "done"}>
        <div class="rp-result">
          <Show
            when={liveStats().converged !== false && !liveStats().hit_timestep_limit}
            fallback={
              <p class="status-block status-warn">
                <TriangleAlert size={14} aria-hidden="true" />
                <span>{t("progress.timestepLimit", { db: num(liveStats().final_energy_db, 1) })}</span>
              </p>
            }
          >
            <p class="status-block status-good">
              <CircleCheck size={14} aria-hidden="true" />
              <span>
                {t(liveStats().timesteps !== undefined ? "progress.convergedAt" : "progress.converged", {
                  db: liveStats().final_energy_db === undefined && liveStats().final_energy_bound_db !== undefined
                    ? `≤ ${num(liveStats().final_energy_bound_db, 1)}`
                    : num(liveStats().final_energy_db, 1),
                  timestep: liveStats().timesteps !== undefined ? fmt.int(liveStats().timesteps!) : undefined,
                  time: seconds(job().duration_s),
                })}
                <Show when={liveStats().bands?.length}>
                  {" "}{t("progress.bandCentres", { count: liveStats().bands!.length })}{" "}
                  <span class="mono">{liveStats().bands!.map((b) => fmt.fixed(b.f_center_ghz, 3)).join("; ")} GHz</span>.
                </Show>
              </span>
            </p>
          </Show>
          <Show when={job().bundle}>
            <button class="btn btn-ghost" onClick={() => openResult(job().bundle!)}>
              <FolderOpen size={14} aria-hidden="true" /> {t("progress.openResults")}
            </button>
          </Show>
        </div>
      </Show>

      <Show when={job().status === "failed" || job().status === "interrupted"}>
        <div class="status-block status-critical" role="alert">
          <CircleX size={14} aria-hidden="true" />
          <div>
            <p>{job().status === "failed" ? t("progress.failed") : t("progress.interrupted")}{job().error ? ":" : "."}</p>
            <Show when={job().error}>
              <p class="mono rs-error-text">{job().error}</p>
            </Show>
          </div>
        </div>
        <Show when={stderrTail().length}>
          <pre class="code rp-stderr">{stderrTail().join("\n")}</pre>
        </Show>
      </Show>

      <details class="rp-log" open={logOpen()} onToggle={(e) => setLogOpen(e.currentTarget.open)}>
        <summary>
          {t("progress.log")} <span class="muted mono">{t("progress.lines", { count: liveLog().length })}</span>
        </summary>
        <pre class="code rp-log-body" ref={logBox}>
          <For each={liveLog()}>{(l) => <span classList={{ "rp-log-err": l.stream === "stderr" }}>{l.line + "\n"}</span>}</For>
        </pre>
        <a class="rp-log-link" href={api.logUrl(job().id)} target="_blank" rel="noopener">
          <FileText size={14} aria-hidden="true" /> {t("progress.fullLog")}
        </a>
      </details>
    </section>
  );
}
