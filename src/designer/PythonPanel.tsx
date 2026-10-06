import { createEffect, createSignal, lazy, on, onCleanup, Show } from "solid-js";
import { Check, Copy, Download, Pencil, Play, X } from "lucide-solid";
import { downloadFailedMessage, downloadMessage, saveDownload } from "../lib/download";
import { applyPython, dirty, draft, exportPython, file, message, selection } from "./store";
import { serverState } from "../runner/store";
import { api } from "../runner/api";
import { confirmDraftDiscard } from "../lib/ConfirmDialog";
import { t } from "../i18n";
import "../styles/python-panel.css";

const PythonSourceView = lazy(() => import("../editor/PythonSourceView"));
const PythonSourceEditor = lazy(() => import("../editor/PythonSourceEditor"));

const [pythonPanelActive, setPythonPanelActive] = createSignal(false);
export const isPythonPanelActive = pythonPanelActive;
let request = 0;
const [source, setSource] = createSignal<string | null>(null);
const [panelError, setPanelError] = createSignal("");
const [feedback, setFeedback] = createSignal("");
const [copied, setCopied] = createSignal(false);
const [stale, setStale] = createSignal(false);
const [sourceChanged, setSourceChanged] = createSignal(false);
// Edit mode: the script being typed, the text it was last in step with (the source when Edit began, or
// what the last Apply left) and the state of an Apply
const [editing, setEditing] = createSignal(false);
const [editText, setEditText] = createSignal("");
const [baseText, setBaseText] = createSignal("");
const [scriptError, setScriptError] = createSignal<{ line: number; message: string } | null>(null);
const [applying, setApplying] = createSignal(false);
const unapplied = () => editing() && editText() !== baseText();

function focusInspector(selectionFocus = false) {
  queueMicrotask(() => {
    const inspector = document.querySelector<HTMLElement>('[data-region="properties"]');
    const target = selectionFocus
      ? inspector?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex="0"]')
      : inspector?.querySelector<HTMLElement>("h2, h3, h4") ?? document.querySelector<HTMLElement>('button[data-action="open-python"]');
    if (target) {
      if (target.matches("h2, h3, h4") || target === inspector) target.tabIndex = -1;
      target.focus();
    }
  });
}

async function refreshSource(preserveSource = false) {
  const ticket = ++request;
  if (!preserveSource) setSource(null);
  setPanelError("");
  setFeedback("");
  const text = await exportPython();
  if (ticket !== request || !pythonPanelActive()) return;
  if (text === null) {
    setPanelError(message()?.text ?? t("python.loadFailed"));
    return;
  }
  setSource(text);
  setStale(false);
  setSourceChanged(false);
}

export async function openPythonPanel(): Promise<void> {
  setEditing(false);
  setPythonPanelActive(true);
  setStale(false);
  setSourceChanged(false);
  setCopied(false);
  setSource(null);
  const design = draft;
  if (design?.python_source_model) {
    const ticket = ++request;
    setPanelError("");
    setFeedback("");
    try {
      const linked = await api.modelSource(design.python_source_model);
      if (ticket === request && pythonPanelActive()) {
        setSource(linked.source);
        setSourceChanged(!!design.python_source_hash && linked.hash !== design.python_source_hash);
        return;
      }
    } catch {
      // A removed source model does not block the Design's own generated Python export.
    }
  }
  await refreshSource();
}

export function closePythonPanel(restoreFocus = true, selectionFocus = false): void {
  ++request;
  setEditing(false);
  setScriptError(null);
  const wasActive = pythonPanelActive();
  setPythonPanelActive(false);
  if (restoreFocus && wasActive) focusInspector(selectionFocus);
}

export function PythonPanel() {
  onCleanup(() => closePythonPanel(false));
  // another design closes the panel; a save of this one (a new file object, same id) does not
  // (not deferred: a deferred `on` passes no previous value on its first change)
  createEffect(on(() => file()?.id, (id, prev) => { if (prev !== undefined && id !== prev) closePythonPanel(false); }));
  // picking a part yields to the Inspector; the same selection set again (the save that the
  // export makes first re-selects it) does not close the panel
  createEffect(on(() => selection(), (s, prev) => {
    // (not while a script is being edited: the typing would be lost)
    if (prev && !editing() && (s.type === "part" || s.type === "primitive") && JSON.stringify(s) !== JSON.stringify(prev)) closePythonPanel(true, true);
  }));
  createEffect(on(() => dirty(), (isDirty) => {
    if (isDirty && pythonPanelActive() && source() !== null && !applying()) setStale(true);
  }));
  const shown = () => (editing() ? editText() : source());
  const offline = () => serverState() !== "online";
  const startEdit = () => {
    const text = source();
    if (text === null || offline()) return;
    setEditText(text);
    setBaseText(text);
    setScriptError(null);
    setPanelError("");
    setFeedback("");
    setEditing(true);
  };
  const stopEdit = async () => {
    if (unapplied() && !(await confirmDraftDiscard(t("python.edit.discardConfirm")))) return;
    setEditing(false);
    setScriptError(null);
    setPanelError("");
  };
  const closeRequest = async () => {
    if (unapplied() && !(await confirmDraftDiscard(t("python.edit.discardConfirm")))) return;
    closePythonPanel();
  };
  const apply = async () => {
    if (!editing() || applying() || offline()) return;
    const sent = editText();
    setApplying(true);
    setScriptError(null);
    setPanelError("");
    setFeedback("");
    try {
      const outcome = await applyPython(sent);
      if (!pythonPanelActive() || !editing()) return;
      if (!outcome.ok) {
        if (outcome.stale) return;
        if (outcome.line) setScriptError({ line: outcome.line, message: outcome.message });
        setPanelError(outcome.line ? t("python.edit.errorLine", { line: outcome.line, message: outcome.message }) : t("python.edit.error", { message: outcome.message }));
        return;
      }
      setSource(outcome.python);
      setStale(false);
      setSourceChanged(false);
      const untouched = editText() === sent;
      if (outcome.normalized && untouched) {
        setEditText(outcome.python);
        setBaseText(outcome.python);
      } else if (untouched) setBaseText(sent);
      setFeedback(outcome.normalized ? t("python.edit.normalized") : t("python.edit.applied"));
    } finally {
      setApplying(false);
    }
  };
  const copy = async () => {
    const text = shown();
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFeedback(t("python.copied"));
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setFeedback(t("python.copyFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
  };
  const save = async () => {
    const text = shown();
    if (text === null) return;
    const name = `${(file()?.id || "design").replace(/[^a-z0-9_-]+/gi, "_")}.py`;
    try {
      const result = await saveDownload(name, text, "text/x-python");
      setFeedback(downloadMessage(result));
    } catch (e) {
      setFeedback(downloadFailedMessage(name, e));
    }
  };
  return (
    <section class="python-panel" aria-label={t("python.title")}>
      <header class="python-panel-head">
        <h2>{t("python.title")}</h2>
        <div class="python-panel-actions">
          <Show when={!editing()} fallback={<>
            <button class="btn btn-primary" data-action="python-apply" onClick={() => void apply()} disabled={applying() || offline()} title={t("python.edit.applyTitle")}><Play size={14} aria-hidden="true" /> {applying() ? t("python.edit.applying") : t("python.edit.apply")}</button>
            <button class="btn btn-ghost" data-action="python-done" onClick={() => void stopEdit()} title={t("python.edit.doneTitle")}>{t("python.edit.done")}</button>
          </>}>
            <button class="btn btn-ghost" data-action="python-edit" onClick={startEdit} disabled={source() === null || offline()} title={offline() ? t("python.edit.needServer") : t("python.edit.title")} aria-describedby={offline() ? "python-edit-offline" : undefined}><Pencil size={14} aria-hidden="true" /> {t("python.edit")}</button>
          </Show>
          <button class="btn btn-ghost" onClick={() => void copy()} disabled={shown() === null}><Show when={copied()} fallback={<Copy size={14} aria-hidden="true" />}>{<Check size={14} aria-hidden="true" />}</Show> {copied() ? t("python.copiedShort") : t("common.copy")}</button>
          <button class="btn btn-ghost" onClick={() => void save()} disabled={shown() === null}><Download size={14} aria-hidden="true" /> {t("python.save")}</button>
          <button class="icon-btn" aria-label={t("python.close")} title={t("python.back")} onClick={() => void closeRequest()}><X size={16} aria-hidden="true" /></button>
        </div>
      </header>
      <Show when={stale() && !editing()}><div class="python-panel-stale" role="status"><span>{t("python.stale")}</span><button class="linklike" onClick={() => void refreshSource(true)} disabled={source() === null}>{t("python.refresh")}</button></div></Show>
      <Show when={sourceChanged() && !editing()}><p class="python-panel-note" role="status">{t("python.sourceChanged")}</p></Show>
      <Show when={offline() && !editing()}><p id="python-edit-offline" class="python-panel-note">{t("python.edit.needServer")}</p></Show>
      <Show when={editing()}><p class="python-panel-note">{t("python.edit.hint")}<Show when={unapplied()}> <strong>{t("python.edit.unsaved")}</strong></Show></p></Show>
      <Show when={panelError()}><p class="python-panel-error" role="alert">{panelError()}</p></Show>
      <Show when={source() !== null} fallback={<Show when={!panelError()}><p class="python-panel-loading" role="status">{t("python.loading")}</p></Show>}>
        <Show when={editing()} fallback={<PythonSourceView source={source()!} />}>
          <PythonSourceEditor text={editText()} ariaLabel={t("python.edit.label")} error={scriptError()}
            onChange={(text) => { setEditText(text); if (scriptError()) { setScriptError(null); setPanelError(""); } }}
            onApply={() => void apply()} />
        </Show>
      </Show>
      <p class="python-panel-feedback" role="status" aria-live="polite">{feedback()}</p>
    </section>
  );
}
