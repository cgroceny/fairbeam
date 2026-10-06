import { createEffect, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { CircleAlert, LoaderCircle, Play, Plus, RefreshCw, RotateCcw, X } from "lucide-solid";
import ParamForm from "../runner/ParamForm";
import ProgressCard from "../runner/ProgressCard";
import RunHistory from "../runner/RunHistory";
import { ApiError, isTerminal } from "../runner/api";
import {
  attach,
  closeRunPanel,
  currentModel,
  engine,
  ensureModel,
  health,
  isModified,
  jobs,
  live,
  mode,
  modelKey,
  models,
  previewActive,
  previewError,
  previewMs,
  previewState,
  probeServer,
  refreshModels,
  resetAll,
  runName,
  runPreview,
  selectModel,
  serverActivity,
  serverState,
  setEngine,
  setMode,
  setRunName,
  setThreads,
  specs,
  startRun,
  submitError,
  submitting,
  threads,
  openExampleCopy,
} from "../runner/store";
import { addAxis, axes, axisValues, lastDuration, MAX_SWEEP_RUNS, removeAxis, resetAxes, setAxes, startSweep, sweepPlan } from "../runner/sweep";
import { seconds } from "../lib/format";
import { bundle, exportOpen } from "../state";
import CodePane from "../editor/CodePane";
import OptimizePanel from "../runner/OptimizePanel";
import OptimizeProgress from "../runner/OptimizeProgress";
import NewModelDialog from "../editor/NewModelDialog";
import { radioGroupKeys } from "../lib/a11y";
import { confirmDiscard, dialog, dirty, panelTab, setDialog, setPanelTab } from "../editor/store";
import { confirmDiscard as confirmDesignDiscard, dirty as designDirty, enterDesign } from "../designer/store";
import { appMode } from "../workspace";
import { openPythonModelAsDesign } from "../designer/pythonModel";
import { t } from "../i18n";
import NumberField from "./NumberField";

const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").toLowerCase().slice(0, 100);

/** One sweep axis: parameter, range or list, and the resulting values. */
function AxisEditor(props: { index: number }) {
  const a = () => axes[props.index];
  const numeric = () => specs().filter((s) => s.type === "int" || s.type === "float");
  const spec = () => specs().find((s) => s.key === a().key);
  const res = () => axisValues(a());
  const id = (k: string) => `axis-${props.index}-${k}`;
  return (
    <fieldset class="rp-axis stack-sm">
      <legend class="visually-hidden">{t("runPanel.axis.legend", { n: props.index + 1 })}</legend>
      <div class="cluster-sm">
        <select class="rp-select rp-select-sm rp-grow" aria-label={t("runPanel.axis.parameter", { n: props.index + 1 })} value={a().key} onChange={(e) => setAxes(props.index, "key", e.currentTarget.value)}>
          <For each={numeric()}>
            {(s) => <option value={s.key} disabled={s.key !== a().key && axes.some((x) => x.key === s.key)}>{s.label} ({s.key})</option>}
          </For>
        </select>
        <div class="seg seg-sm" role="radiogroup" aria-label={t("runPanel.axis.valuesAs")} onKeyDown={radioGroupKeys}>
          <button class="seg-btn" role="radio" aria-checked={a().kind === "range"} onClick={() => setAxes(props.index, "kind", "range")}>{t("runPanel.axis.range")}</button>
          <button class="seg-btn" role="radio" aria-checked={a().kind === "list"} onClick={() => setAxes(props.index, "kind", "list")}>{t("runPanel.axis.list")}</button>
        </div>
        <button class="icon-btn icon-btn-sm" onClick={() => removeAxis(props.index)} aria-label={t("runPanel.axis.stopSweeping", { key: a().key })} title={t("common.remove")}>
          <X size={14} />
        </button>
      </div>
      <Show
        when={a().kind === "range"}
        fallback={
          <label class="rp-mini" for={id("list")}>
            <span>{t("runPanel.axis.values")}{spec()?.unit ? ` (${spec()!.unit})` : ""}</span>
            <input autocomplete="off" id={id("list")} class="rp-input" type="text" inputmode="decimal" value={a().list} placeholder="56, 58, 60" onInput={(e) => setAxes(props.index, "list", e.currentTarget.value)} />
          </label>
        }
      >
        <div class="rp-range">
          <label class="rp-mini" for={id("start")}><span>{t("runPanel.axis.start")}{spec()?.unit ? ` (${spec()!.unit})` : ""}</span>
            <NumberField id={id("start")} class="rp-input" step="any" value={a().start} onInput={(e) => setAxes(props.index, "start", e.currentTarget.value)} />
          </label>
          <label class="rp-mini" for={id("stop")}><span>{t("runPanel.axis.stop")}</span>
            <NumberField id={id("stop")} class="rp-input" step="any" value={a().stop} onInput={(e) => setAxes(props.index, "stop", e.currentTarget.value)} />
          </label>
          <label class="rp-mini" for={id("steps")}><span>{t("runPanel.axis.steps")}</span>
            <NumberField id={id("steps")} class="rp-input" min="1" max={MAX_SWEEP_RUNS} step="1" value={a().steps} onInput={(e) => setAxes(props.index, "steps", e.currentTarget.value)} />
          </label>
        </div>
      </Show>
      <Show
        when={!res().error}
        fallback={<p class="rp-error" role="alert"><CircleAlert size={12} aria-hidden="true" /> {res().error}</p>}
      >
        <p class="rp-hint mono">{res().values.length} × {res().values.join(", ")}</p>
      </Show>
    </fieldset>
  );
}

/** Right-hand drawer that replaces the spec panel while open: model, parameters with live
 * geometry preview, single run or sweep, solver settings, live progress and the run history. */
export default function RunPanel() {
  let heading!: HTMLHeadingElement;
  let readonlyChoice!: HTMLDialogElement;
  const [pythonDesignBusy, setPythonDesignBusy] = createSignal(false);
  const [pythonDesignError, setPythonDesignError] = createSignal<{ id: string; message: string } | null>(null);

  const openCreatedPythonAsDesign = async (sourceId: string) => {
    if (pythonDesignBusy()) return;
    setPythonDesignError(null);
    setPythonDesignBusy(true);
    try {
      await openPythonModelAsDesign(sourceId);
    } catch (err) {
      const a = err as ApiError;
      await refreshModels();
      setPanelTab("code");
      setPythonDesignError({ id: sourceId, message: a.status === 0 ? t("home.serverUnreachable") : a.message });
    } finally {
      setPythonDesignBusy(false);
    }
  };

  onMount(() => {
    heading.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || exportOpen() || dialog() || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "SELECT") return; // let an open select close first
      if (target?.closest(".cm-editor")) return; // Escape belongs to the editor (search panel, selection)
      e.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  // while the server is away, look again every 5 s (quietly)
  createEffect(() => {
    if (serverState() !== "offline") return;
    const id = setInterval(() => probeServer(), 5000);
    onCleanup(() => clearInterval(id));
  });

  // the server came up while the panel was open: fill the form
  createEffect(() => {
    if (serverState() === "online" && models().length && !untrack(modelKey)) untrack(ensureModel);
  });

  // another model: drop sweep axes that do not exist there
  createEffect(on(modelKey, () => {
    const keys = specs().map((s) => s.key);
    if (axes.some((a) => !keys.includes(a.key))) resetAxes();
  }));

  // re-attach to a run that is still going (after a page reload, or a run another client started,
  // #7): the running one, not the newest queued one
  createEffect(() => {
    if (live.job) return;
    const running = jobs().find((j) => j.status === "running") ?? jobs().find((j) => !isTerminal(j.status));
    if (running) attach(running);
  });

  const isDesign = () => currentModel()?.kind === "design";
  const secondTab = () => (isDesign() ? "design" : "code");
  /** designs are edited in the designer workspace, not in this drawer */
  const openInDesigner = () => {
    const key = modelKey();
    closeRunPanel();
    setPanelTab("run");
    void enterDesign(key);
  };
  // a design picked while the code tab was open (or the other way round): follow the model's kind
  createEffect(() => {
    const tab = panelTab();
    if (tab === "design") setPanelTab("run"); // designs open in the designer workspace
    else if (tab !== "run" && tab !== secondTab()) setPanelTab("run");
  });

  const close = () => {
    closeRunPanel();
    document.getElementById("run-toggle")?.focus();
  };

  const cpuOptions = () => Array.from({ length: health()?.cpu_count ?? 1 }, (_, i) => i + 1);
  const modified = () => specs().filter(isModified).length;
  const running = () => !!live.job && !isTerminal(live.job.status);
  /** a run this window did not start or does not follow keeps the server busy (#7): a new run queues */
  const otherBusy = () => !running() && serverActivity().busy;
  const otherName = () => { const o = serverActivity().other; return o ? o.label ?? o.model_id ?? o.model : null; };
  const engines = () => health()?.engines ?? ["cpu"];
  const sweeping = () => mode() === "sweep";
  const readonlyExample = () => !!currentModel()?.readonly && currentModel()?.kind !== "design";
  const askReadonly = (kind: "run" | "sweep") => {
    if (!readonlyExample()) {
      kind === "run" ? void startRun() : void startSweep();
      return;
    }
    readonlyChoice.dataset.action = kind;
    readonlyChoice.showModal();
  };
  const runPristine = () => {
    resetAll();
    const used = new Set(jobs().map((j) => j.name ?? ""));
    const base = `${currentModel()?.model?.name ?? "Example"} run`;
    let n = 2;
    let candidate = base;
    while (used.has(candidate)) candidate = `${base} ${n++}`;
    setRunName(candidate);
  };
  const estimate = () => {
    const d = lastDuration();
    const n = sweepPlan().count;
    if (!n) return null;
    return d ? { total: d.seconds * n, each: d.seconds } : null;
  };
  const fileName = () => {
    const s = slug(runName());
    if (!s) return null;
    return sweeping() ? `${s}--${axes.map((a) => `${a.key}-…`).join("--")}.json` : `${s}.json`;
  };

  return (
    <aside id="run-panel" class="panel panel-right run-panel" aria-labelledby="run-panel-title">
      <div class="rp-head">
        <h2 id="run-panel-title" class="rp-title" tabindex={-1} ref={heading}>{t("runPanel.title")}</h2>
        <button class="icon-btn" onClick={close} title={t("runPanel.closeTitle")} aria-label={t("runPanel.closeLabel")}>
          <X size={16} />
        </button>
      </div>

      <Show when={serverState() === "online"}>
        <div class="rp-tabs" role="tablist" aria-label={t("runPanel.views")}>
          <button role="tab" class="tab" id="rp-tab-run" aria-selected={panelTab() === "run"} aria-controls="rp-view" tabindex={panelTab() === "run" ? 0 : -1}
            onClick={() => setPanelTab("run")} onKeyDown={(e) => (e.key === "ArrowRight" || e.key === "ArrowLeft") && (setPanelTab(secondTab()), document.getElementById("rp-tab-code")?.focus())}>
            {t("runPanel.tab.run")}
          </button>
          <button role="tab" class="tab" id="rp-tab-code" aria-selected={panelTab() === secondTab()} aria-controls="rp-view" tabindex={panelTab() === secondTab() ? 0 : -1}
            onClick={() => (isDesign() ? openInDesigner() : setPanelTab(secondTab()))} onKeyDown={(e) => (e.key === "ArrowRight" || e.key === "ArrowLeft") && (setPanelTab("run"), document.getElementById("rp-tab-run")?.focus())}>
            <Show when={isDesign()} fallback={<>{t("runPanel.tab.code")}<Show when={dirty()}><span class="code-dot" aria-label={t("runPanel.unsaved")} /></Show></>}>
              {appMode() === "design" ? t("runPanel.tab.backToDesigner") : t("runPanel.tab.openInDesigner")}<Show when={designDirty()}><span class="code-dot" aria-label={t("runPanel.unsaved")} /></Show>
            </Show>
          </button>
        </div>
      </Show>
      <Show when={dialog()}>
        <NewModelDialog onPythonCreated={(id) => void openCreatedPythonAsDesign(id)} />
      </Show>

      <Show when={pythonDesignBusy()}><p class="note" role="status">{t("runPanel.pythonDesignCreating")}</p></Show>
      <Show when={pythonDesignError()}>
        <div class="status-block status-warn" role="alert">
          <CircleAlert size={14} aria-hidden="true" />
          <span>{t("runPanel.pythonDesignFailed", { error: pythonDesignError()!.message })}</span>
          <button class="btn btn-ghost btn-sm" disabled={pythonDesignBusy()} onClick={() => void openCreatedPythonAsDesign(pythonDesignError()!.id)}>
            {t("runPanel.pythonDesignRetry")}
          </button>
        </div>
      </Show>

      <Show
        when={serverState() === "online"}
        fallback={
          <section class="section stack">
            <Show when={serverState() === "checking" || serverState() === "unknown"} fallback={
              <>
                <p>{t("runPanel.offline.before")}<span class="mono">fairbeam serve</span>{t("runPanel.offline.after")}</p>
                <pre class="code code-inline">npm run serve</pre>
                <p class="note">
                  {t("runPanel.offline.or")}<span class="mono">~/opt/openEMS/venv/bin/fairbeam serve</span>{t("runPanel.offline.viewer")}
                </p>
                <div class="cluster">
                  <button class="btn btn-ghost btn-sm" onClick={() => probeServer()}>
                    <RefreshCw size={14} aria-hidden="true" /> {t("runPanel.checkAgain")}
                  </button>
                </div>
              </>
            }>
              <p class="muted rs-inline"><LoaderCircle size={14} class="rs-spin" aria-hidden="true" /> {t("runPanel.looking")}</p>
            </Show>
          </section>
        }
      >
        <Show when={panelTab() === "code" && !isDesign()}>
          <div id="rp-view" role="tabpanel" aria-labelledby="rp-tab-code">
            <CodePane newDisabled={pythonDesignBusy()} />
          </div>
        </Show>

        <Show when={panelTab() === "run"}>
        <div id="rp-view" role="tabpanel" aria-labelledby="rp-tab-run">
        <section class="section stack">
          <div class="rp-label-row">
            <label class="section-label" for="rp-model">{t("runPanel.model")}</label>
            <button class="btn btn-ghost btn-sm" disabled={pythonDesignBusy()} onClick={() => setDialog("new")} title={t("runPanel.newTitle")}>
              <Plus size={13} aria-hidden="true" /> {t("runPanel.new")}
            </button>
          </div>
          <select id="rp-model" class="rp-select" value={modelKey()} onChange={(e) => {
            const select = e.currentTarget.value;
            e.currentTarget.value = modelKey();
            void (async () => {
              if (!(await confirmDiscard()) || !(await confirmDesignDiscard())) return;
              selectModel(select, bundle()); resetAxes(); runPreview();
            })();
          }}>
            <Show when={!modelKey()}><option value="">{t("runPanel.chooseModel")}</option></Show>
            <For each={models()}>
              {(m) => (
                <option value={m.key} disabled={!!m.error}>
                  {m.model?.name ?? m.file}{m.error ? ` ${t("runPanel.doesNotLoad")}` : ""} · {m.file}
                </option>
              )}
            </For>
          </select>
          <Show when={currentModel()?.model?.description}>
            <p class="section-lede rp-desc">{currentModel()!.model!.description}</p>
          </Show>
          <Show when={readonlyExample()}>
            <p class="note">{t("runPanel.readonlyNote")}</p>
            <button class="btn btn-ghost btn-sm" onClick={() => currentModel() && openExampleCopy(currentModel()!.key)}>
              {t("examples.copy.button")}
            </button>
          </Show>
          <Show when={models().some((m) => m.error)}>
            <details class="rp-broken">
              <summary class="rs-inline rs-warn-text"><CircleAlert size={14} aria-hidden="true" /> {t("runPanel.brokenModels", { count: models().filter((m) => m.error).length })}</summary>
              <For each={models().filter((m) => m.error)}>
                {(m) => <p class="mono note">{m.file}: {m.error}</p>}
              </For>
            </details>
          </Show>
        </section>

        <Show when={currentModel() && !currentModel()!.error}>
          <section class="section">
            <div class="section-label">
              {t("runPanel.parameters")}
              <Show when={modified()}>
                <button class="btn btn-ghost btn-sm push" onClick={resetAll} title={t("runPanel.resetTitle")}>
                  <RotateCcw size={14} aria-hidden="true" /> {t("runPanel.reset", { count: modified() })}
                </button>
              </Show>
            </div>
            <ParamForm swept={sweeping() ? axes.map((a) => a.key) : []} />
            <p class="rp-preview-status" aria-live="polite">
              <Show when={previewState() === "loading"}>
                <LoaderCircle size={14} class="rs-spin" aria-hidden="true" /> {t("runPanel.preview.updating")}
              </Show>
              <Show when={previewState() === "ready" && previewActive()}>
                {t("runPanel.preview.updated")} <span class="mono">{previewMs()} ms</span> · {t("runPanel.preview.geometryOnly")}
              </Show>
              <Show when={previewState() === "error"}>
                <span class="rs-inline rs-critical-text"><CircleAlert size={14} aria-hidden="true" /> {previewError()}</span>
              </Show>
              <Show when={previewState() === "idle"}>
                <span class="muted">{t("runPanel.preview.idle")}</span>
              </Show>
            </p>
          </section>

          <section class="section stack">
            <div class="section-label">
              {t("runPanel.tab.run")}
              <div class="seg seg-sm push" role="radiogroup" aria-label={t("runPanel.mode")} onKeyDown={radioGroupKeys}>
                <button class="seg-btn" role="radio" aria-checked={mode() === "single"} onClick={() => setMode("single")}>{t("runPanel.mode.single")}</button>
                <button class="seg-btn" role="radio" aria-checked={sweeping()} onClick={() => { setMode("sweep"); if (!axes.length) addAxis(); }}>{t("runPanel.mode.sweep")}</button>
                <button class="seg-btn" role="radio" aria-checked={mode() === "optimize"} onClick={() => setMode("optimize")}>{t("runPanel.mode.optimize")}</button>
              </div>
            </div>
            <Show when={mode() !== "optimize"} fallback={<OptimizePanel />}>
            <Show when={sweeping()}>
              <For each={axes}>{(_, i) => <AxisEditor index={i()} />}</For>
              <div class="cluster-sm">
                <Show when={axes.length < 2}>
                  <button class="btn btn-ghost btn-sm" onClick={addAxis}>
                    <Plus size={14} aria-hidden="true" /> {axes.length ? t("runPanel.secondParameter") : t("runPanel.parameterToSweep")}
                  </button>
                </Show>
              </div>
              <dl class="kv">
                <dt>{t("runPanel.runs")}</dt>
                <dd class="mono">{sweepPlan().count} <span class="muted">{t("runPanel.runsMax", { max: MAX_SWEEP_RUNS })}</span></dd>
                <dt>{t("runPanel.estimate")}</dt>
                <dd class="mono">
                  <Show when={estimate()} fallback={<span class="muted rp-prose">{t("runPanel.noFinishedRun", { model: currentModel()?.model?.id ?? "" })}</span>}>
                    ≈ {seconds(estimate()!.total)}
                    <span class="kv-sub">{sweepPlan().count} × {seconds(estimate()!.each)} {t("runPanel.lastRunEach")}</span>
                  </Show>
                </dd>
              </dl>
              <Show when={sweepPlan().error && axes.length}>
                <p class="rp-error" role="alert"><CircleAlert size={12} aria-hidden="true" /> {sweepPlan().error}</p>
              </Show>
            </Show>
            <label class="rp-mini" for="rp-name">
              <span>{sweeping() ? t("runPanel.sweepName") : t("runPanel.runName")} <span class="muted">{t("runPanel.optional")}</span></span>
              <input autocomplete="off" id="rp-name" class="rp-input rp-input-text" type="text" maxlength="80" value={runName()} placeholder={sweeping() ? t("runPanel.sweepNamePlaceholder") : t("runPanel.runNamePlaceholder")} onInput={(e) => setRunName(e.currentTarget.value)} />
            </label>
            <p class="rp-hint">
              <Show when={fileName()} fallback={<>{t("runPanel.fileAuto")}</>}>
                {t("runPanel.projectFile")} <span class="mono">{fileName()}</span>{sweeping() ? "" : ` ${t("runPanel.fileReplaced")}`}
              </Show>
            </p>
            <div class="cluster">
              <Show when={engine() !== "gpu"}><label class="rp-inline-field">
                <span>{t("runPanel.threads")}</span>
                <select class="rp-select rp-select-sm" value={threads()} onChange={(e) => setThreads(Number(e.currentTarget.value))}>
                  <option value={0}>{t("run.threads.auto")} ({health()?.default_threads ?? 1})</option>
                  <For each={cpuOptions()}>{(n) => <option value={n}>{n}</option>}</For>
                </select>
              </label></Show>
              <Show when={engines().length > 1}>
                <label class="rp-inline-field">
                  <span>{t("runPanel.engine")}</span>
                  <select class="rp-select rp-select-sm" value={engine()} onChange={(e) => setEngine(e.currentTarget.value)}>
                    <For each={engines()}>{(e) => <option value={e}>{e === "gpu" ? "GPU" : e === "cpu" ? "CPU" : e}</option>}</For>
                  </select>
                </label>
              </Show>
            </div>
            <p class="note">{engine() === "gpu" ? t("runPanel.gpuNote") : t("runPanel.threadsNote", { cores: health()?.cpu_count })}</p>
            <Show when={submitError()}>
              <p class="status-block status-critical" role="alert"><CircleAlert size={14} aria-hidden="true" /> <span>{submitError()}</span></p>
            </Show>
            <Show
              when={sweeping()}
              fallback={
                <button class="btn btn-primary rp-start-btn" onClick={() => askReadonly("run")} disabled={submitting() || !currentModel()}>
                  <Show when={submitting()} fallback={<Play size={14} aria-hidden="true" />}>
                    <LoaderCircle size={14} class="rs-spin" aria-hidden="true" />
                  </Show>
                  {running() || otherBusy() ? t("runPanel.queue") : t("runPanel.start")}
                </button>
              }
            >
              <button class="btn btn-primary rp-start-btn" onClick={() => askReadonly("sweep")} disabled={submitting() || !!sweepPlan().error}>
                <Show when={submitting()} fallback={<Play size={14} aria-hidden="true" />}>
                  <LoaderCircle size={14} class="rs-spin" aria-hidden="true" />
                </Show>
                {t("runPanel.startSweep", { count: sweepPlan().count })}
              </button>
            </Show>
            <Show when={running()}>
              <p class="note">{t("runPanel.inProgress")}</p>
            </Show>
            <Show when={otherBusy()}>
              <p class="note" role="status" data-testid="rp-other-run">
                {serverActivity().otherRunning
                  ? otherName() ? t("runPanel.otherRunning", { name: otherName()! }) : t("runPanel.otherRunningUnknown")
                  : t("runPanel.otherQueued", { count: serverActivity().queued })}
              </p>
            </Show>
            <Show when={serverActivity().external > 0}>
              <p class="note" role="status">{t("runPanel.externalRuns", { count: serverActivity().external })}</p>
            </Show>
            </Show>
          </section>
        </Show>

        <Show when={live.job}>
          <Show when={live.job?.kind === "optimize"} fallback={<ProgressCard />}><OptimizeProgress /></Show>
        </Show>

        <RunHistory />
        </div>
        </Show>
      </Show>
      <dialog ref={readonlyChoice} class="example-copy-dialog" aria-labelledby="readonly-example-title"
        onCancel={(e) => { e.preventDefault(); readonlyChoice.close(); }}>
        <h2 id="readonly-example-title">{t("runPanel.readonly.title")}</h2>
        <p>{t("runPanel.readonly.text")}</p>
        <div class="cluster-sm">
          <button class="btn btn-primary" onClick={() => {
            readonlyChoice.close();
            if (currentModel()) openExampleCopy(currentModel()!.key);
          }}>{t("common.copy")}</button>
          <button class="btn btn-ghost" onClick={() => {
            runPristine();
            readonlyChoice.close();
            readonlyChoice.dataset.action === "sweep" ? void startSweep() : void startRun();
          }}>{t("runPanel.readonly.runAsIs")}</button>
          <button class="btn btn-ghost" onClick={() => readonlyChoice.close()}>{t("common.cancel")}</button>
        </div>
      </dialog>
    </aside>
  );
}
