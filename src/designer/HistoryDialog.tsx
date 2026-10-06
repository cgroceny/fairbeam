import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { listKeyTarget } from "../lib/tabKeys";
import { invalidatePreview, showEmptyDesign, showQuickPreview } from "../runner/store";
import { quickBundle } from "./geometry";
import { paramValues } from "./expr";
import { draft, goToHistory, historyDesign, historyIndex, historySteps, names, schedulePreview } from "./store";
import { kindLabel } from "./DesignPane";
import { pathText } from "./pathText";
import "../styles/history.css";
import { fmt, t } from "../i18n";

type HistoryEntry = { index: number; label: string; at: string | number | Date; target: string; current: boolean };

function timeLabel(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : fmt.dateTime(date);
}

/** A step's label: the first step's "Initial state" (store.ts) in the UI language. */
const stepLabel = (label: string) => (!label || label === "Initial state" ? t("history.initialState") : label);

/** Where a step edited, in words ("patch › Brick 1", "Parameter W (expression)"), not as a JSON path.
 * The path is read against the design as it was at that step. A step that only names the selection
 * (design, port…) says nothing more than its label does. */
const targetText = (step: { index: number; target: string }): string => {
  const target = step.target;
  if (!target) return "";
  if (!/[.[]/.test(target)) return target === "design" ? t("props.checks.design") : "";
  return pathText(target, historyDesign(step.index) ?? draft, kindLabel);
};

export function HistoryDialog(props: { onClose: () => void }) {
  let box!: HTMLDivElement;
  let list!: HTMLDivElement;
  const [selected, setSelected] = createSignal<number | null>(null);
  const steps = (): HistoryEntry[] => historySteps();
  const activeIndex = () => selected() ?? historyIndex();
  const activeStep = () => steps().find((step) => step.index === activeIndex());
  const restorePreview = () => {
    const live = quickBundle(draft, names().names, null);
    if (live) showQuickPreview(live);
    else if (!draft.parts.length) showEmptyDesign(draft.model.name);
  };

  const close = () => {
    props.onClose();
  };

  // focus starts on the selected (current) step, so the arrow keys work at once
  useModal(() => box, close, () => list?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]'));

  // Track only the selected step: the preview store's signals (the shown bundle) are read and
  // written by showQuickPreview, and tracking them re-ran this effect forever (#132).
  createEffect(on(selected, (index) => {
    if (index === null) return;
    const design = historyDesign(index);
    if (!design) return;
    invalidatePreview();
    const bundle = quickBundle(design, paramValues(design.params ?? []).names, null);
    if (bundle) showQuickPreview(bundle);
    else if (!design.parts.length) showEmptyDesign(design.model.name);
  }));

  onCleanup(() => {
    restorePreview();
    schedulePreview();
  });

  // listbox keys: Up/Down/Home/End move the focus, the selection (and the preview) follow it
  const onListKey = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const all = steps();
    const target = listKeyTarget(event.key, all.findIndex((step) => step.index === activeIndex()), all.length);
    if (target === null) return;
    event.preventDefault();
    setSelected(all[target].index);
    list.querySelector<HTMLElement>(`[data-step="${all[target].index}"]`)?.focus();
  };

  const revert = () => {
    const index = activeIndex();
    goToHistory(index);
    props.onClose();
  };

  return <Portal>
    <div class="scrim history-scrim" onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <div class="dialog history-dialog" ref={box} role="dialog" aria-modal="true" aria-labelledby="history-title" tabindex={-1}>
        <div class="dialog-head">
          <div><h2 id="history-title">{t("history.title")}</h2><p class="muted">{t("history.description")}</p></div>
          <button class="icon-btn" type="button" aria-label={t("history.closeAria")} onClick={close} data-noprompt><X size={16} /></button>
        </div>
        <div class="history-body">
          <div class="history-list" ref={list} role="listbox" aria-label={t("history.listAria")} onKeyDown={onListKey}>
            <For each={steps()}>{(step: HistoryEntry) => {
              const isCurrent = () => step.current || step.index === historyIndex();
              const isFuture = () => step.index > historyIndex();
              const isSelected = () => step.index === activeIndex();
              return <button type="button" role="option" aria-selected={isSelected()} tabindex={isSelected() ? 0 : -1} data-step={step.index} classList={{ selected: isSelected(), future: isFuture() }}
                onClick={() => setSelected(step.index)} class="history-step">
                <span class="history-step-top"><strong>{stepLabel(step.label)}</strong>
                  <Show when={isCurrent()}><span class="history-current">{t("history.current")}</span></Show>
                  <Show when={isFuture()}><span class="history-future">{t("history.future")}</span></Show>
                </span>
                <span class="history-meta">{timeLabel(step.at)}{targetText(step) ? ` · ${targetText(step)}` : ""}</span>
              </button>;
            }}</For>
            <Show when={!steps().length}><p class="history-empty">{t("history.initialState")}</p></Show>
          </div>
          <aside class="history-detail" aria-live="polite">
            <Show when={activeStep()} keyed fallback={<p class="muted">{t("history.initialState")}</p>}>
              {(step) => <>
                <p class="history-detail-label">{stepLabel(step.label)}</p>
                <p class="muted">{timeLabel(step.at)}</p>
                <Show when={targetText(step)}><p class="muted">{t("history.target", { target: targetText(step) })}</p></Show>
                <p class="history-preview-note">{t("history.previewNote")}</p>
              </>}
            </Show>
          </aside>
        </div>
        <div class="dialog-foot">
          <span class="muted">{activeStep() && targetText(activeStep()!) ? t("history.target", { target: targetText(activeStep()!) }) : t("history.history")}</span>
          <div class="dialog-actions">
            <button class="btn btn-ghost" type="button" onClick={close} data-noprompt>{t("common.close")}</button>
            <button class="btn btn-primary" type="button" onClick={revert} disabled={activeIndex() === historyIndex()}>{t("history.revert")}</button>
          </div>
        </div>
      </div>
    </div>
  </Portal>;
}
