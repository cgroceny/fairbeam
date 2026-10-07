import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { CircleAlert, LoaderCircle, Plus, X } from "lucide-solid";
import "../styles/sweep-dialog.css";
import { useModal } from "../lib/dialog";
import { saveDownload } from "../lib/download";
import { api, isTerminal } from "../runner/api";
import {
  attachDesignOptimize,
  prepareDesignOptimize,
  setDesignDockTab,
  setSweepDialogOpen,
  sweepDialogOpen,
} from "../runner/designRun";
import {
  jobs,
  refreshRuns,
  runSettings,
  setSubmitError,
  setSubmitting,
  specs,
  submitting,
} from "../runner/store";
import { axes, lastDuration, setAxes } from "../runner/sweep";
import { PreflightNote } from "./PreflightNote";
import { draftMeshStats } from "./draftMesh";
import { draft, editParameterSweep, file, names } from "./store";
import { MAX_SWEEP_CELLS, planParameterSweep } from "./sweepPlan";
import { pickVaryParam, sweepRange } from "../lib/rangeDefaults";
import { setBottomDockCollapsed } from "./layoutState";
import type { ParameterSweepDefinition, ParameterSweepSequence } from "./types";
import { fmt, t } from "../i18n";
import { paramLabelText } from "../lib/paramLabel";
import { currentSchema } from "../lib/legacy";

const empty = (): ParameterSweepDefinition => ({
  schema: "fairbeam.parameter-sweep/1",
  sequences: [{ name: "Sequence 1", axes: [] }],
});
const [selected, setSelected] = createSignal(0);
const [runId, setRunId] = createSignal<string | null>(null);
/** errors (shown as an alert) */
const [notice, setNotice] = createSignal("");
/** neutral feedback: a passed Check, an import (shown as a status line) */
const [info, setInfo] = createSignal("");
export async function openDesignerSweep() {
  const savedAxes = axes.map((axis) => ({ ...axis }));
  const err = await prepareDesignOptimize();
  // Preparing the design selects a different model in the shared Run panel. Restore its axes after
  // the RunPanel model-change effect has had a chance to discard axes for that model.
  setAxes(savedAxes);
  if (err) setNotice(err);
  else setNotice("");
  setInfo("");
  setSelected(0);
  setSweepDialogOpen(true);
}
export default function SweepDialog() {
  return (
    <Show when={sweepDialogOpen()}>
      <Content />
    </Show>
  );
}
function Content() {
  // the current design's mesh: the memory check of the whole batch
  const designCells = () => draftMeshStats()?.nodes;
  let box: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  const close = () => setSweepDialogOpen(false);
  useModal(
    () => box,
    close,
    () => box?.querySelector<HTMLElement>("input,select,button"),
  );
  const definition = () => draft.parameter_sweep ?? empty();
  const seq = () =>
    definition().sequences[selected()] ?? definition().sequences[0];
  const put = (sequences: ParameterSweepSequence[]) =>
    editParameterSweep({ schema: "fairbeam.parameter-sweep/1", sequences });
  const mutate = (fn: (s: ParameterSweepSequence) => ParameterSweepSequence) =>
    put(definition().sequences.map((s, i) => (i === selected() ? fn(s) : s)));
  // a model's int parameters (the server refuses non-whole samples); a design's are all float
  const intKeys = () =>
    new Set(specs().filter((p) => p.type === "int").map((p) => p.key));
  const plan = () =>
    planParameterSweep(
      definition(),
      draft,
      names().names,
      lastDuration()?.seconds ?? null,
      null,
      intKeys(),
    );
  const activeId = () => runId();
  const group = () => jobs().filter((j) => j.sweep?.id === activeId());
  const done = () => group().filter((j) => j.status === "done").length;
  const active = createMemo(() => group().some((j) => !isTerminal(j.status)));
  // the run list only refreshes on the attached run's events: poll it while this sweep has queued or
  // running runs, and stop as soon as none is left (or the dialog closes)
  createEffect(() => {
    if (!active()) return;
    const timer = setInterval(() => void refreshRuns(), 1000);
    onCleanup(() => clearInterval(timer));
  });
  // the run being simulated now, not the next queued one
  const current = () => group().find((j) => j.status === "running");
  const valuesText = (v?: Record<string, number>) =>
    v ? Object.entries(v).map(([k, x]) => `${k} = ${x}`).join(", ") : "";
  const [stopping, setStopping] = createSignal(false);
  const stop = async () => {
    const id = activeId();
    if (!id || stopping()) return;
    setStopping(true);
    try {
      await api.cancelSweep(id);
      await refreshRuns();
    } catch (e) {
      setNotice(t("sweep.err.stop", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setStopping(false);
    }
  };
  const start = async () => {
    if (plan().error || submitting()) return;
    setSubmitError(null);
    setSubmitting(true);
    setNotice("");
    setInfo("");
    try {
      if (!draft.parameter_sweep) editParameterSweep(definition());
      const err = await prepareDesignOptimize();
      if (err) throw new Error(err);
      const f = file();
      if (!f) throw new Error(t("sweep.err.noDesign"));
      const base: Record<string, number> = Object.fromEntries(
        draft.params
          .filter((p) => p.expr === undefined)
          .map((p) => [p.key, names().names[p.key]])
          .filter(([, v]) => typeof v === "number"),
      );
      const sequences = plan().sequences.map((s) => ({
        name: s.name,
        sweep: s.sweep,
      }));
      const result = await api.submitSweep({
        model: f.id,
        params: base,
        sequences,
        ...(designCells() ? { cells: designCells() } : {}),
        ...runSettings(),
      });
      setRunId(result.sweep.id);
      await refreshRuns();
      if (result.runs[0]) {
        attachDesignOptimize(result.runs[0]);
        setDesignDockTab("run");
        setBottomDockCollapsed(false);
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };
  // a new range starts as the parameter's current value ±10 % in 5 steps (never its whole min..max)
  const seedRange = (key: string) => {
    const p = draft.params.find((x) => x.key === key);
    const value = names().names[key] ?? p?.default;
    const current = typeof value === "number" && Number.isFinite(value) ? value : 1;
    return sweepRange(current, { min: p?.min, max: p?.max });
  };
  const addAxis = () => {
    const used = new Set(seq().axes.map((a) => a.key));
    const p = pickVaryParam(draft.params.filter((x) => x.expr === undefined), used);
    if (!p) return;
    mutate((s) => ({
      ...s,
      axes: [...s.axes, { key: p.key, kind: "range", ...seedRange(p.key) }],
    }));
  };
  const exportFile = () =>
    void saveDownload(
      `${file()?.design.model.id ?? "design"}-sweep.json`,
      JSON.stringify(definition(), null, 2),
      "application/json",
    );
  const importFile = async (f?: File) => {
    if (!f) return;
    try {
      const raw = JSON.parse(await f.text());
      // a sweep file with the older schema id imports as before (src/lib/legacy.ts)
      if (currentSchema(raw?.schema) !== "fairbeam.parameter-sweep/1" || !Array.isArray(raw.sequences))
        throw new Error(t("sweep.err.schema"));
      raw.schema = "fairbeam.parameter-sweep/1";
      const candidate = raw as ParameterSweepDefinition,
        checked = planParameterSweep(candidate, draft, names().names, null, null, intKeys());
      if (checked.error) throw new Error(checked.error);
      editParameterSweep(candidate);
      setSelected(0);
      setNotice("");
      setInfo(t("sweep.imported"));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      if (input) input.value = "";
    }
  };
  return (
    <div
      class="scrim"
      onPointerDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        class="dialog dialog-sm rd-dialog sd-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sd-title"
        ref={box}
        tabindex={-1}
      >
        <div class="dialog-head">
          <div>
            <h2 id="sd-title">{t("sweep.title")}</h2>
            <p class="muted">
              {t("sweep.subtitle")}
            </p>
          </div>
          <button class="icon-btn" onClick={close} aria-label={t("common.close")}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div class="sd-body">
          <div class="sd-layout">
            <div class="sd-sequences" role="group" aria-label={t("sweep.sequences")}>
              <For each={definition().sequences}>
                {(s, i) => (
                  <button
                    class={`btn btn-ghost btn-sm ${selected() === i() ? "active" : ""}`}
                    aria-pressed={selected() === i()}
                    aria-current={selected() === i() ? "true" : undefined}
                    onClick={() => setSelected(i())}
                  >
                    {s.name || t("sweep.sequenceN", { n: i() + 1 })}
                  </button>
                )}
              </For>
              <button
                class="btn btn-ghost btn-sm"
                onClick={() => {
                  const n = definition().sequences.length;
                  put([
                    ...definition().sequences,
                    { name: `Sequence ${n + 1}`, axes: [] },
                  ]);
                  setSelected(n);
                }}
              >
                <Plus size={14} aria-hidden="true" /> {t("sweep.newSequence")}
              </button>
            </div>
            <div class="sd-editor">
              <Show when={seq()}>
                {(s) => (
                  <>
                    <label class="rp-mini">
                      {t("sweep.sequenceName")}
                      <input autocomplete="off"
                        class="rp-input"
                        value={s().name}
                        onInput={(e) =>
                          mutate((x) => ({ ...x, name: e.currentTarget.value }))
                        }
                      />
                    </label>
                    <For each={s().axes}>
                      {(axis, i) => (
                        <fieldset class="rp-axis stack-sm">
                          <legend class="visually-hidden">{t("sweep.axisLegend", { n: i() + 1 })}</legend>
                          <div class="sd-axis-head">
                            <select
                              class="rp-select"
                              aria-label={t("sweep.parameterN", { n: i() + 1 })}
                              value={axis.key}
                              onChange={(e) =>
                                mutate((x) => ({
                                  ...x,
                                  axes: x.axes.map((a, k) =>
                                    k === i()
                                      // another parameter: its own window (the old one may be outside its limits)
                                      ? { ...a, key: e.currentTarget.value, ...(a.kind === "range" ? { ...seedRange(e.currentTarget.value), steps: a.steps } : {}) }
                                      : a,
                                  ),
                                }))
                              }
                            >
                              <For
                                each={draft.params.filter(
                                  (p) => p.expr === undefined,
                                )}
                              >
                                {(p) => (
                                  <option value={p.key}>
                                    {paramLabelText(p.label) ?? p.key} ({p.key})
                                  </option>
                                )}
                              </For>
                            </select>
                            <select
                              class="rp-select"
                              aria-label={t("sweep.kindAria", { key: axis.key })}
                              value={axis.kind}
                              onChange={(e) =>
                                mutate((x) => ({
                                  ...x,
                                  axes: x.axes.map((a, k) => {
                                    if (k !== i()) return a;
                                    return e.currentTarget.value === "range"
                                      ? { key: a.key, kind: "range", ...seedRange(a.key) }
                                      : { key: a.key, kind: "list", list: "" };
                                  }),
                                }))
                              }
                            >
                              <option value="range">{t("sweep.kind.range")}</option>
                              <option value="list">{t("sweep.kind.list")}</option>
                            </select>
                            <button
                              class="icon-btn"
                              aria-label={t("sweep.removeAxis", { key: axis.key })}
                              onClick={() =>
                                mutate((x) => ({
                                  ...x,
                                  axes: x.axes.filter((_, k) => k !== i()),
                                }))
                              }
                            >
                              <X size={14} aria-hidden="true" />
                            </button>
                          </div>
                          <Show
                            when={axis.kind === "range"}
                            fallback={
                              <label class="rp-mini">
                                {t("sweep.listValues")}
                                <input autocomplete="off"
                                  class="rp-input"
                                  value={axis.kind === "list" ? axis.list : ""}
                                  onInput={(e) =>
                                    mutate((x) => ({
                                      ...x,
                                      axes: x.axes.map((a, k) =>
                                        k === i() && a.kind === "list"
                                          ? {
                                              ...a,
                                              list: e.currentTarget.value,
                                            }
                                          : a,
                                      ),
                                    }))
                                  }
                                />
                              </label>
                            }
                          >
                            <div class="stack-sm">
                            <div class="rp-range">
                              {(["start", "stop", "steps"] as const).map(
                                (k) => (
                                  <label class="rp-mini">
                                    {k === "steps" ? t("sweep.range.steps") : k === "start" ? t("sweep.range.start") : t("sweep.range.stop")}
                                    <input autocomplete="off"
                                      class="rp-input"
                                      value={
                                        axis.kind === "range" ? axis[k] : ""
                                      }
                                      onInput={(e) =>
                                        mutate((x) => ({
                                          ...x,
                                          axes: x.axes.map((a, j) =>
                                            j === i() && a.kind === "range"
                                              ? {
                                                  ...a,
                                                  [k]: e.currentTarget.value,
                                                }
                                              : a,
                                          ),
                                        }))
                                      }
                                    />
                                  </label>
                                ),
                              )}
                            </div>
                            <p class="rp-hint">{t("sweep.range.hint")}</p>
                            </div>
                          </Show>
                        </fieldset>
                      )}
                    </For>
                    <button class="btn btn-ghost btn-sm" onClick={addAxis}>
                      <Plus size={14} aria-hidden="true" /> {t("sweep.addParameter")}
                    </button>
                    <div class="sd-actions">
                      <button class="btn btn-ghost btn-sm" onClick={exportFile}>
                        {t("sweep.export")}
                      </button>
                      <button
                        class="btn btn-ghost btn-sm"
                        onClick={() => input?.click()}
                      >
                        {t("sweep.import")}
                      </button>
                      <input
                        ref={input}
                        type="file"
                        accept="application/json,.json"
                        hidden
                        onChange={(e) =>
                          void importFile(e.currentTarget.files?.[0])
                        }
                      />
                      <button
                        class="btn btn-ghost btn-sm"
                        aria-label={t("sweep.deleteSequence", { name: s().name })}
                        onClick={() => {
                          const n = definition().sequences.length;
                          put(
                            definition().sequences.filter(
                              (_, i) => i !== selected(),
                            ),
                          );
                          setSelected(Math.max(0, Math.min(selected(), n - 2)));
                        }}
                      >
                        {t("common.delete")}
                      </button>
                    </div>
                  </>
                )}
              </Show>
            </div>
          </div>
          <div class="sd-summary">
            <button
              class="btn btn-ghost btn-sm"
              onClick={() => {
                // a dry run: validates and counts, never submits anything
                setNotice("");
                setInfo(plan().error ? "" : t("sweep.checkPassed", { count: plan().count }));
              }}
            >
              {t("sweep.check")}
            </button>
            <span>
              {t("sweep.cells", { count: plan().count, max: MAX_SWEEP_CELLS })}
              {plan().warning ? ` · ${plan().warning}` : ""}
              {plan().estimateSeconds != null
                ? ` · ${t("sweep.estimated", { seconds: fmt.int(Math.round(plan().estimateSeconds!)) })}`
                : ""}
            </span>
          </div>
          <PreflightNote cells={designCells()} engine={runSettings().engine ?? "cpu"} />
          <Show when={plan().error || notice()}>
            <p class="status-block status-critical" role="alert">
              <CircleAlert size={14} aria-hidden="true" />
              {plan().error ?? notice()}
            </p>
          </Show>
          <Show when={!plan().error && !notice() && info()}>
            <p class="note" role="status">{info()}</p>
          </Show>
          <Show when={activeId() && group().length}>
            <p class="note" role="status">
              {t("sweep.progress", { done: done(), total: group()[0]?.sweep?.total ?? group().length })}
              {current() ? ` · ${t("sweep.current", { values: valuesText(current()!.sweep?.values) })}` : active() ? ` · ${t("sweep.queued")}` : ""}
              <Show when={active()}>
                <button class="btn btn-ghost btn-sm" onClick={() => void stop()} disabled={stopping()}>
                  {t("common.stop")}
                </button>
              </Show>
            </p>
          </Show>
          <button
            class="btn btn-primary rp-start-btn"
            onClick={start}
            disabled={submitting() || !!plan().error}
          >
            <Show when={submitting()} fallback={<Plus size={14} aria-hidden="true" />}>
              <LoaderCircle size={14} class="rs-spin" aria-hidden="true" />
            </Show>
            {t("sweep.start")}
          </button>
        </div>
      </div>
    </div>
  );
}
