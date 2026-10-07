// The designer's Run dialog: engine, threads, frequency points and a name
// for the result. It saves the design first when it has unsaved changes and refuses while the
// Checks list has errors; the run itself goes through the run store (src/runner/store.ts), and
// its progress and results show in the designer's bottom dock (RunDock.tsx).
import { createSignal, For, onMount, Show } from "solid-js";
import { CircleAlert, Play, X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { engine as storedEngine, health, probeServer, selectModel, serverState, setThreads, submitError, submitErrorDetail, submitting, threads as storedThreads } from "../runner/store";
import { setRunDialogOpen, startDesignRun, storedPoints } from "../runner/designRun";
import { estimateText } from "./meshStats";
import { draftEstimate, draftExcitedPorts, draftMeshStats } from "./draftMesh";
import { PreflightNote } from "./PreflightNote";
import { addPort, applyFix, checks, conflict, dirty, draft, errorCount, file, focusPath, save, saving } from "./store";
import { openDesignerOptimize } from "./OptimizeDialog";
import { readGeneralSettings } from "../lib/generalSettings";
import { autoThreads } from "../lib/autoThreads";
import { t } from "../i18n";
import { checkFixLabel, checkTitle } from "./checkText";
import { checkAction } from "./checkActions";
import { checkPlace, kindLabel } from "./DesignPane";
import { humanizePaths } from "./pathText";
import "../styles/run-quality.css";
import NumberField from "../components/NumberField";

/** i18n keys of the engine names */
const ENGINE_LABEL: Record<string, string> = { cpu: "run.engine.cpu", gpu: "run.engine.gpu" };

export default function RunDialog() {
  let box: HTMLDivElement | undefined;
  let first: HTMLSelectElement | HTMLInputElement | undefined;
  const close = () => setRunDialogOpen(false);
  useModal(() => box, close, () => first);

  const engines = () => health()?.engines ?? ["cpu"];
  const defaults = readGeneralSettings();
  const preferred = defaults.engine === "gpu" && engines().includes("gpu") ? "gpu" : defaults.engine;
  const [eng, setEng] = createSignal(engines().includes(storedEngine()) && storedEngine() !== "cpu" ? storedEngine() : engines().includes(preferred) ? preferred : "cpu");
  // 0 is Auto. The store's choice already follows live > remembered Run choice > Settings default.
  const [thr, setThr] = createSignal(Math.min(health()?.cpu_count ?? 64, storedThreads()));
  const [points, setPoints] = createSignal(storedPoints());
  const [name, setName] = createSignal("");
  const [err, setErr] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    if (serverState() !== "online") probeServer();
  });

  const errors = () => checks().filter((c) => c.severity === "error");
  const excited = draftExcitedPorts;
  // the draft's own mesh and timestep limit, never a run shown in the 3D view
  const est = () => draftEstimate(eng());
  const cpu = () => health()?.cpu_count ?? 64;
  const pointsBad = () => !Number.isInteger(points()) || points() < 11 || points() > 20001;
  const threadsBad = () => eng() === "cpu" && thr() !== 0 && (!Number.isInteger(thr()) || thr() < 1 || thr() > cpu());
  // memory / CPU check of this mesh (the server refuses the run above ~90 % of free memory)
  const cells = () => draftMeshStats()?.nodes;
  // what Auto resolves to for this grid: the server's rule with the cell count the run sends (a big
  // grid gets more threads than the small-grid default health() reports)
  const autoCount = () => autoThreads(cpu(), health()?.physical_cores, cells());

  const run = async (e: Event) => {
    e.preventDefault();
    const f = file();
    if (!f || busy()) return;
    setErr(null);
    if (serverState() !== "online" && !(await probeServer())) {
      setErr(t("run.err.server"));
      return;
    }
    setBusy(true);
    try {
      if (dirty() || conflict()) await save();
      if (dirty()) {
        setErr(t("run.err.notSaved"));
        return;
      }
      if (errorCount() > 0) return; // the list below says what to fix
      selectModel(f.id);
      const job = await startDesignRun({ engine: eng(), threads: eng() === "gpu" ? 1 : thr(), points: points(), name: name().trim() });
      if (job) close();
      else setErr(submitError() ?? t("run.err.notStarted"));
    } finally {
      setBusy(false);
    }
  };

  const optimize = () => {
    close();
    void openDesignerOptimize();
  };

  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog dialog-sm rd-dialog" role="dialog" aria-modal="true" aria-labelledby="rd-title" ref={box} tabindex={-1}>
        <div class="dialog-head">
          <div>
            <h2 id="rd-title">{t("run.title")}</h2>
            <p class="muted">
              <b>{draft.model?.name}</b>
              <Show when={dirty()}> · {t("run.unsavedFirst")}</Show>
              . {t("run.dockNote")}
            </p>
          </div>
          <button class="icon-btn" onClick={close} aria-label={t("common.close")}><X size={16} /></button>
        </div>
        <form class="rd-body" id="rd-form" onSubmit={run}>
          <Show when={errors().length}>
            <div class="status-block status-critical" role="alert">
              <CircleAlert size={14} aria-hidden="true" />
              <div>
                <p>{t("run.fixErrors", { count: errors().length })}</p>
                <ul class="rd-errors">
                  <For each={errors().slice(0, 6)}>{(c) => (
                    <li>
                      {/* every row names its place in words (pathText), also inside the message */}
                      <button type="button" class="linklike" onClick={() => { close(); focusPath(c.path); }}>{humanizePaths(checkTitle(c), draft, kindLabel)}</button>
                      <span class="rd-where">
                        <span class="muted">{checkPlace(c)}</span>
                        {/* the check's own one-click fix (raise max timesteps, ...): the list follows the new checks */}
                        <Show when={c.fix}>{(f) => <button type="button" class="btn btn-ghost btn-sm rd-fix" onClick={() => applyFix(f().set)}>{checkFixLabel(c)}</button>}</Show>
                        <Show when={checkAction(c, draft.ports?.length ?? 0)}><button type="button" class="btn btn-ghost btn-sm rd-fix" onClick={() => { close(); addPort(); }}>{t("contextMenu.addPort")}</button></Show>
                      </span>
                    </li>
                  )}</For>
                </ul>
                <Show when={errors().length > 6}><p class="muted">{t("run.moreErrors", { count: errors().length - 6 })}</p></Show>
              </div>
            </div>
          </Show>
          <div class="rd-grid">
            <label class="dz-field">
              <span class="dz-label">{t("run.engine")}</span>
              <select ref={(el) => (first = el)} class="rp-select dz-input" value={eng()} onChange={(e) => setEng(e.currentTarget.value)}>
                <For each={engines()}>{(x) => <option value={x}>{ENGINE_LABEL[x] ? t(ENGINE_LABEL[x]) : x}</option>}</For>
              </select>
            </label>
            <Show when={eng() === "cpu"} fallback={<p class="dz-value">{t("run.gpuNote")}</p>}>
              <label class="dz-field">
                <span class="dz-label">{t("run.threads")} <span class="dz-unit">1–{cpu()}</span></span>
                <label class="gs-check"><input type="checkbox" checked={thr() === 0}
                  onChange={(e) => { const n = e.currentTarget.checked ? 0 : autoCount(); setThr(n); setThreads(n); }} /> {t("run.threads.auto")}</label>
                <Show when={thr() !== 0}>
                  <NumberField class="rp-input dz-input mono" min="1" max={cpu()} step="1" value={thr()}
                    aria-invalid={threadsBad()} onInput={(e) => { const n = Number(e.currentTarget.value); setThr(n); if (Number.isInteger(n) && n >= 1 && n <= cpu()) setThreads(n); }} />
                </Show>
                <span class="dz-value dz-wrap" classList={{ "dz-bad": threadsBad() }}>{threadsBad() ? t("run.threads.bad", { max: cpu() }) : thr() === 0 ? t("run.threads.autoHint", { n: autoCount() }) : t("run.threads.hint")}</span>
              </label>
            </Show>
            <label class="dz-field">
              <span class="dz-label">{t("run.points")}</span>
              <NumberField class="rp-input dz-input mono" min="11" max="20001" step="1" value={points()} aria-invalid={pointsBad()}
                onInput={(e) => setPoints(Number(e.currentTarget.value))} />
              <span class="dz-value dz-wrap" classList={{ "dz-bad": pointsBad() }}>{pointsBad() ? t("run.points.bad") : t("run.points.hint")}</span>
            </label>
            <label class="dz-field">
              <span class="dz-label">{t("run.name")} <span class="dz-unit">{t("run.optional")}</span></span>
              <input autocomplete="off" class="rp-input dz-input" type="text" maxlength="80" value={name()} placeholder={t("run.name.placeholder", { id: draft.model?.id ?? "design" })}
                onInput={(e) => setName(e.currentTarget.value)} />
              <span class="dz-value dz-wrap">{t("run.name.hint")}</span>
            </label>
          </div>
          {/* a blocked run has no time to estimate: "< 1 s" would read as if it were about to finish */}
          <Show when={!errors().length}>
            <dl class="kv rd-est">
              <dt>{t("run.estimate")}</dt>
              <dd><span class="mono">{estimateText(est())}</span>{excited() > 1 ? <span class="muted"> · {t("run.excitedPorts", { count: excited() })}</span> : null}</dd>
            </dl>
            <p class="note">{t("run.estimateNote", { basis: est()?.basis ?? t("run.estimate.noMesh") })}</p>
          </Show>
          <PreflightNote cells={cells()} engine={eng()} />
          <Show when={err()}>
            <div class="status-block status-critical" role="alert">
              <CircleAlert size={14} aria-hidden="true" />
              <div>
                <p>{humanizePaths(err()!, draft, kindLabel)}</p>
                <Show when={err() === submitError() && submitErrorDetail()}>
                  <details class="rd-details"><summary>{t("common.details")}</summary><p class="mono">{submitErrorDetail()}</p></details>
                </Show>
              </div>
            </div>
          </Show>
        </form>
        <div class="dialog-foot">
          <span class="muted">{serverState() === "online" ? t("run.server.online", { version: health()?.openems ?? "?" }) : serverState() === "checking" ? t("run.server.checking") : t("run.server.offline")}</span>
          <div class="dialog-actions">
            <button class="btn btn-ghost" type="button" onClick={close}>{t("common.cancel")}</button>
            <button class="btn btn-ghost" type="button" onClick={optimize} disabled={busy() || saving()}>{t("run.optimize")}</button>
            <button class="btn btn-primary" type="submit" form="rd-form"
              disabled={busy() || saving() || submitting() || errors().length > 0 || pointsBad() || threadsBad()}>
              <Play size={14} aria-hidden="true" /> {busy() ? (saving() ? t("run.saving") : t("run.starting")) : dirty() ? t("run.saveAndRun") : t("run.run")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

