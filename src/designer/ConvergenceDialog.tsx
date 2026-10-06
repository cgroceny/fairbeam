// Mesh convergence study (Simulation › Mesh › Mesh convergence…): the densities and tolerances,
// the estimated total time before anything starts, then the progress and the report (table, small
// plots, verdict) with the offer to apply the converged density. The study runs on the server
// (POST /api/convergence, python/fairbeam/convergence.py); its runs appear in the navigation tree
// in one "Mesh convergence" folder, whose "Convergence report" row opens this dialog again.
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { CircleAlert, LoaderCircle, Play, TriangleAlert, X } from "lucide-solid";
import "../styles/convergence.css";
import { useModal } from "../lib/dialog";
import { api, isTerminal } from "../runner/api";
import { attachDesignOptimize, prepareDesignOptimize } from "../runner/designRun";
import { engine, health, jobs, refreshRuns, runSettings, setEngine } from "../runner/store";
import type { Bundle } from "../types";
import {
  DEFAULT_DENSITIES, DEFAULT_MAX_RUNS, DEFAULT_TOL, type ConvergenceStudy, currentDensity, designAtDensity,
  longStudyWarning, meshBlocker, parseDensities, planDensities, plotPoints, reportRows, series, setDensity, totalEstimate, verdictDetail,
} from "./convergence";
import { PreflightNote } from "./PreflightNote";
import { cellsText, durationText, estimateText, estimateTime, meshStats, type TimeEstimate } from "./meshStats";
import { draft, edit, file } from "./store";
import { setBottomDockCollapsed } from "./layoutState";
import type { Design } from "./types";
import { fmt, t } from "../i18n";

/** open: null closed; studyId null shows the setup, else that study's progress and report */
const [open, setOpen] = createSignal<{ studyId: string | null } | null>(null);
const [densText, setDensText] = createSignal(DEFAULT_DENSITIES.join(", "));
const [tolF, setTolF] = createSignal(String(DEFAULT_TOL.f_pct));
const [tolS, setTolS] = createSignal(String(DEFAULT_TOL.s11_db));
const [tolD, setTolD] = createSignal(String(DEFAULT_TOL.dmax_db));
const [maxRuns, setMaxRuns] = createSignal(String(DEFAULT_MAX_RUNS));

/** Open the setup, or the report of a study (the navigation tree's "Convergence report"). */
export function openMeshConvergence(studyId: string | null = null) {
  setOpen({ studyId });
}

export default function ConvergenceDialog() {
  return <Show when={open()}>{(o) => <Content studyId={o().studyId} />}</Show>;
}

type Estimate = { density: number; cells: number | null; nodes?: number; est: TimeEstimate | null; error?: string };

function Content(props: { studyId: string | null }) {
  let box: HTMLDivElement | undefined;
  const close = () => setOpen(null);
  useModal(() => box, close, () => box?.querySelector<HTMLElement>("input,button"));
  const [studyId, setStudyId] = createSignal(props.studyId);
  const [notice, setNotice] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  // ---- setup
  const parsed = createMemo(() => parseDensities(densText()));
  const runs = () => Number(maxRuns());
  const tol = () => ({ f_pct: Number(tolF()), s11_db: Number(tolS()), dmax_db: Number(tolD()) });
  const planned = () => planDensities(parsed().values, runs());
  const blocker = () => meshBlocker(draft);
  const setupError = () => {
    if (blocker()) return blocker();
    if (parsed().error) return parsed().error!;
    if (!Number.isInteger(runs()) || runs() < 2 || runs() > 12) return t("conv.err.maxRuns");
    if (Object.values(tol()).some((v) => !Number.isFinite(v) || v <= 0)) return t("conv.err.tolerances");
    if (planned().length < 2) return t("conv.err.twoDensities");
    return null;
  };
  const engines = () => health()?.engines ?? ["cpu"];
  const excited = () => Math.max(1, (draft.ports ?? []).filter((p) => p.excite !== false).length);
  const [estimates, setEstimates] = createSignal<Estimate[]>([]);
  const [estimating, setEstimating] = createSignal(false);
  // one geometry preview per density (nothing is simulated): the mesh size and the time estimate
  createEffect(on(() => [studyId(), setupError(), planned().join(","), engine(), JSON.stringify(draft.mesh), JSON.stringify(draft.simulation)] as const, ([id, err]) => {
    if (id || err) { setEstimates([]); return; }
    const ctl = new AbortController();
    const snapshot = JSON.parse(JSON.stringify(draft)) as Design;
    const eng = engine();
    const timer = setTimeout(async () => {
      setEstimating(true);
      const out: Estimate[] = [];
      for (const d of planned()) {
        try {
          const r = await api.previewDesign(designAtDensity(snapshot, d), {}, ctl.signal);
          const b = r.bundle as Bundle;
          out.push({ density: d, cells: meshStats(b)?.cells ?? null, nodes: meshStats(b)?.nodes, est: estimateTime(b, eng, excited()) });
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          out.push({ density: d, cells: null, est: null, error: e instanceof Error ? e.message : String(e) });
        }
        if (ctl.signal.aborted) return;
        setEstimates([...out]);
      }
      setEstimating(false);
    }, 300);
    onCleanup(() => { clearTimeout(timer); ctl.abort(); setEstimating(false); });
  }));
  const total = () => (estimates().length === planned().length ? totalEstimate(estimates().map((e) => e.est)) : null);
  // the densest mesh of the study (the last density is the largest) is what the memory check sees
  const largestNodes = () => estimates().reduce<number | undefined>((m, e) => (e.nodes && (!m || e.nodes > m) ? e.nodes : m), undefined);
  const warning = () => longStudyWarning(total());

  const start = async () => {
    if (setupError() || busy()) return;
    setBusy(true);
    setNotice("");
    try {
      const err = await prepareDesignOptimize(); // saves the design and refuses check errors
      if (err) throw new Error(err);
      const f = file();
      if (!f) throw new Error(t("conv.err.noDesign"));
      const res = await api.submitConvergence({ model: f.id, params: {}, densities: planned(), ...(largestNodes() ? { cells: largestNodes() } : {}), tolerances: tol(), max_runs: runs(), ...runSettings() });
      setStudyId(res.study.id);
      setStudy(res.study);
      await refreshRuns();
      if (res.runs[0]) {
        attachDesignOptimize(res.runs[0]);
        setBottomDockCollapsed(false);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- progress and report
  const [study, setStudy] = createSignal<ConvergenceStudy | null>(null);
  const group = () => jobs().filter((j) => j.sweep?.id === studyId());
  const active = createMemo(() => group().some((j) => !isTerminal(j.status)));
  const finished = createMemo(() => group().filter((j) => isTerminal(j.status)).length);
  createEffect(() => {
    if (!active()) return;
    const timer = setInterval(() => void refreshRuns(), 1500);
    onCleanup(() => clearInterval(timer));
  });
  createEffect(on(() => [studyId(), finished(), active()] as const, ([id]) => {
    if (!id) return;
    api.convergence(id).then(setStudy).catch((e) => setNotice(t("conv.err.read", { error: e instanceof Error ? e.message : String(e) })));
  }));
  const current = () => group().find((j) => j.status === "running") ?? group().find((j) => !isTerminal(j.status));
  const [stopping, setStopping] = createSignal(false);
  const stop = async () => {
    const id = studyId();
    if (!id || stopping()) return;
    setStopping(true);
    try {
      await api.cancelSweep(id);
      await refreshRuns();
    } catch (e) {
      setNotice(t("conv.err.stop", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setStopping(false);
    }
  };
  const convergedAt = () => (study()?.convergence.done ? study()!.convergence.converged_at : null);
  const applied = () => { const c = convergedAt(); return c != null && currentDensity(draft) === c; };
  const apply = () => {
    const c = convergedAt();
    if (c == null || blocker()) return;
    edit((d) => setDensity(d, c), "mesh-convergence", t("conv.applyUndo"));
  };
  const cellNum = (v: number | null, nd: number, signed = false) => (v == null ? "—" : `${signed && v > 0 ? "+" : ""}${fmt.fixed(v, nd)}`.replace("-", "−"));

  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog dialog-sm rd-dialog cv-dialog" role="dialog" aria-modal="true" aria-labelledby="cv-title" ref={box} tabindex={-1}>
        <div class="dialog-head">
          <div>
            <h2 id="cv-title">{t("conv.title")}</h2>
            <p class="muted">{t("conv.subtitle")}</p>
          </div>
          <button class="icon-btn" onClick={close} aria-label={t("common.close")}><X size={16} aria-hidden="true" /></button>
        </div>
        <div class="cv-body">
          <Show when={!studyId()}>
            <div class="cv-grid">
              <label class="rp-mini cv-wide">{t("conv.densities.label")}
                <input autocomplete="off" class="rp-input mono" aria-label={t("conv.densities")} value={densText()} onInput={(e) => setDensText(e.currentTarget.value)} />
              </label>
              <label class="rp-mini">{t("conv.tol.f")}
                <input autocomplete="off" class="rp-input mono" aria-label={t("conv.tol.f.aria")} inputmode="decimal" value={tolF()} onInput={(e) => setTolF(e.currentTarget.value)} />
              </label>
              <label class="rp-mini">{t("conv.tol.s11")}
                <input autocomplete="off" class="rp-input mono" aria-label={t("conv.tol.s11.aria")} inputmode="decimal" value={tolS()} onInput={(e) => setTolS(e.currentTarget.value)} />
              </label>
              <label class="rp-mini">{t("conv.tol.dmax")}
                <input autocomplete="off" class="rp-input mono" aria-label={t("conv.tol.dmax.aria")} inputmode="decimal" value={tolD()} onInput={(e) => setTolD(e.currentTarget.value)} />
              </label>
              <label class="rp-mini" title={t("conv.maxRuns.title")}>{t("conv.maxRuns")}
                <input autocomplete="off" class="rp-input mono" aria-label={t("conv.maxRuns")} inputmode="numeric" value={maxRuns()} onInput={(e) => setMaxRuns(e.currentTarget.value)} />
              </label>
              <Show when={engines().length > 1}>
                <label class="rp-mini">{t("run.engine")}
                  <select class="rp-input" aria-label={t("run.engine")} value={engine()} onChange={(e) => setEngine(e.currentTarget.value)}>
                    <For each={engines()}>{(e) => <option value={e}>{e === "gpu" ? "GPU" : "CPU"}</option>}</For>
                  </select>
                </label>
              </Show>
            </div>
            <Show when={!setupError() && planned().length < parsed().values.length}>
              <p class="note" role="status">{t("conv.cappedNote", { runs: planned().length, total: parsed().values.length })}</p>
            </Show>
            <p class="note">
              {t("conv.stopNote")}
              {currentDensity(draft) != null ? ` ${t("conv.currentDensity", { density: fmt.num(currentDensity(draft)!, 3) })}` : ""}
            </p>
            <Show when={!setupError()}>
              <table class="table cv-table" aria-label={t("conv.estimateTable")}>
                <thead><tr><th class="num">{t("conv.col.density")}</th><th class="num">{t("conv.col.cells")}</th><th class="num">{t("conv.col.solverTime")}</th></tr></thead>
                <tbody>
                  <For each={planned()}>{(d) => {
                    const e = () => estimates().find((x) => x.density === d);
                    return <tr><td class="num">{d}</td><td class="num">{e()?.cells != null ? cellsText(e()!.cells!) : e()?.error ? "—" : "…"}</td>
                      <td class="num" title={e()?.error ?? e()?.est?.basis}>{e() ? (e()!.error ? t("conv.previewFailed") : estimateText(e()!.est)) : "…"}</td></tr>;
                  }}</For>
                </tbody>
              </table>
              <p class="note" role="status">
                {t("conv.total", { value: total() ? t("conv.totalRange", { min: durationText(total()![0]), max: durationText(total()![1]) }) : estimating() ? t("conv.estimating") : t("conv.unknown") })}
              </p>
            </Show>
            <Show when={warning()}>
              <p class="status-block status-warn" role="alert"><TriangleAlert size={14} aria-hidden="true" />{warning()}</p>
            </Show>
          </Show>

          <Show when={studyId()}>
            <Show when={study()} fallback={<p class="note">{t("conv.loading")}</p>}>{(s) => (
              <>
                <p class="note" role="status">
                  <Show when={active()} fallback={<strong class={s().convergence.converged ? "cv-good" : "cv-bad"}>{verdictDetail(s())}</strong>}>
                    {t("conv.runOf", { n: Math.min(s().members.length + 1, s().convergence.max_runs), max: s().convergence.max_runs })}
                    {current()?.mesh_density ? ` · ${t(current()!.status === "running" ? "conv.current.running" : "conv.current.queued", { density: current()!.mesh_density! })}` : ""}
                    {" "}<button class="btn btn-ghost btn-sm" onClick={() => void stop()} disabled={stopping()}>{t("common.stop")}</button>
                  </Show>
                </p>
                <Show when={s().members.length}>
                  <div class="cv-table-wrap">
                    <table class="table cv-table" aria-label={t("conv.results")}>
                      <thead><tr>
                        <th class="num">{t("conv.col.density")}</th><th class="num">{t("conv.col.cells")}</th><th class="num">{t("conv.col.fres")}</th><th class="num">Δf (%)</th><th class="num">|S11| (dB)</th><th class="num">Δ (dB)</th>
                        <th class="num">Dmax (dBi)</th><th class="num">Δ (dB)</th><th class="num">Zin (Ω)</th><th class="num">{t("conv.col.time")}</th><th>{t("conv.col.within")}</th>
                      </tr></thead>
                      <tbody>
                        <For each={reportRows(s())}>{(r) => (
                          <tr classList={{ "cv-chosen": r.chosen }}>
                            <td class="num">{r.density}</td><td class="num">{r.cells != null ? cellsText(r.cells) : "—"}</td>
                            <td class="num">{cellNum(r.fGhz, 4)}</td><td class="num">{cellNum(r.df, 3, true)}</td>
                            <td class="num">{cellNum(r.s11, 2)}</td><td class="num">{cellNum(r.ds11, 2, true)}</td>
                            <td class="num">{cellNum(r.dmax, 2)}</td><td class="num">{cellNum(r.ddmax, 3, true)}</td>
                            <td class="num">{r.zin}</td><td class="num">{r.time != null ? durationText(r.time) : "—"}</td>
                            <td title={r.notComparable ? t("conv.notComparable.title") : undefined}>{r.status !== "done" ? r.status : r.notComparable ? t("conv.notComparable") : r.ok == null ? "" : r.ok ? t("conv.yes") : t("conv.no")}</td>
                          </tr>
                        )}</For>
                      </tbody>
                    </table>
                  </div>
                  <div class="cv-plots">
                    <Plot study={s()} k="f_res" label={t("conv.plot.fres")} nd={4} />
                    <Plot study={s()} k="s11_db" label={t("conv.plot.s11")} nd={2} />
                    <Plot study={s()} k="dmax_dbi" label="Dmax (dBi)" nd={2} />
                  </div>
                  <p class="note">
                    {t("conv.tolerances", { f: fmt.num(s().convergence.tolerances.f_pct, 4), s11: fmt.num(s().convergence.tolerances.s11_db, 4), dmax: fmt.num(s().convergence.tolerances.dmax_db, 4) })}
                  </p>
                </Show>
                <Show when={convergedAt() != null}>
                  <div class="cluster-sm">
                    <button class="btn btn-primary btn-sm" onClick={apply} disabled={applied() || !!blocker()}>
                      {applied() ? t("conv.applied", { density: fmt.num(convergedAt()!, 3) }) : t("conv.apply", { density: fmt.num(convergedAt()!, 3) })}
                    </button>
                  </div>
                </Show>
              </>
            )}</Show>
          </Show>

          <Show when={!studyId() && !setupError()}><PreflightNote cells={largestNodes()} engine={engine()} /></Show>
          <Show when={(!studyId() && setupError()) || notice()}>
            <p class="status-block status-critical" role="alert"><CircleAlert size={14} aria-hidden="true" />{notice() || setupError()}</p>
          </Show>
          <div class="cv-actions">
            <Show when={studyId()} fallback={
              <button class="btn btn-primary" onClick={() => void start()} disabled={busy() || !!setupError()}>
                <Show when={busy()} fallback={<Play size={14} aria-hidden="true" />}><LoaderCircle size={14} class="rs-spin" aria-hidden="true" /></Show>
                {warning() ? t("conv.startAnyway") : t("conv.start")}
              </button>
            }>
              <Show when={!active()}><button class="btn btn-ghost btn-sm" onClick={() => { setStudyId(null); setStudy(null); setNotice(""); }}>{t("conv.newStudy")}</button></Show>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A small line plot of one quantity against the density, the converged density marked. */
function Plot(props: { study: ConvergenceStudy; k: "f_res" | "s11_db" | "dmax_dbi"; label: string; nd: number }) {
  const W = 180, H = 72;
  const pts = () => series(props.study, props.k);
  const xy = () => plotPoints(pts(), W, H);
  const at = () => props.study.convergence.converged_at;
  const range = () => {
    const ys = pts().map((p) => p.y);
    const num = (v: number) => fmt.fixed(v, props.nd).replace("-", "−");
    return ys.length ? `${num(Math.min(...ys))} – ${num(Math.max(...ys))}` : t("conv.noData");
  };
  return (
    <figure class="cv-plot">
      <figcaption>{props.label}</figcaption>
      <Show when={pts().length} fallback={<p class="muted cv-empty">{t("conv.noData")}</p>}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={t("conv.plotAria", { label: props.label, range: range() })}>
          <polyline class="cv-line" points={xy().map((p) => `${p.x},${p.y}`).join(" ")} />
          <For each={xy()}>{(p, i) => <circle class="cv-dot" classList={{ "cv-dot-chosen": pts()[i()].x === at() }} cx={p.x} cy={p.y} r={3} />}</For>
        </svg>
        <div class="cv-axis mono muted"><span>{pts()[0].x}</span><span>{range()}</span><span>{t("conv.cellsPerLambda", { density: pts()[pts().length - 1].x })}</span></div>
      </Show>
    </figure>
  );
}
