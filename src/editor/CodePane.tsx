import { createEffect, For, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";
import { CircleAlert, CircleCheck, Copy, FilePlus2, History, LoaderCircle, Lock, RefreshCw, Save, TriangleAlert } from "lucide-solid";
import { modelKey, models, selectModel, runPreview } from "../runner/store";
import { bundle } from "../state";
import {
  conflict,
  dirty,
  file,
  gotoLine,
  loadVersion,
  loading,
  message,
  openSource,
  prettyVersion,
  save,
  saving,
  setDialog,
  syncToModel,
  validation,
  versions,
  confirmDiscard,
  SAVE_KEY,
} from "./store";

import { t } from "../i18n";

const CodeEditor = lazy(() => import("./CodeEditor"));

/** The Code tab of the Run panel: the model file in an editor, save + validate + preview,
 * errors with their line, new / duplicate, and the saved-version history. */
export default function CodePane(props: { newDisabled?: boolean } = {}) {
  onMount(syncToModel);
  createEffect(() => {
    modelKey();
    syncToModel();
  });

  // leaving the page with unsaved edits
  onMount(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty()) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    onCleanup(() => window.removeEventListener("beforeunload", onUnload));
  });

  const pick = async (key: string) => {
    if (key === modelKey()) return;
    if (!(await confirmDiscard())) return;
    selectModel(key, bundle());
    runPreview();
  };
  const err = () => (validation() && !validation()!.valid ? validation()!.error : undefined);
  /** "Bundled example, read-only. <Duplicate it> to edit a copy." around the link */
  const readonlyNote = () => t("editor.code.readonly", { link: "\u0001" }).split("\u0001");

  return (
    <div class="code-pane">
      <section class="section stack">
        <div class="cluster">
          <label class="visually-hidden" for="code-model">{t("editor.code.modelFile")}</label>
          <select id="code-model" class="rp-select rp-grow" value={modelKey()} onChange={(e) => { const key = e.currentTarget.value; e.currentTarget.value = modelKey(); void pick(key); }}>
            <For each={models()}>{(m) => <option value={m.key}>{m.file}{m.readonly ? ` ${t("editor.code.readonlySuffix")}` : ""}</option>}</For>
          </select>
          <button class="btn btn-ghost btn-sm" onClick={() => setDialog("new")} disabled={props.newDisabled} title={t("editor.code.newTitle")}>
            <FilePlus2 size={14} aria-hidden="true" /> {t("editor.code.new")}
          </button>
          <button class="btn btn-ghost btn-sm" onClick={() => setDialog("duplicate")} disabled={!file()} title={t("editor.code.duplicateTitle")}>
            <Copy size={14} aria-hidden="true" /> {t("editor.code.duplicate")}
          </button>
        </div>

        <Show when={file()?.readonly}>
          <div class="status-block status-warn">
            <Lock size={14} aria-hidden="true" />
            <span>
              {readonlyNote()[0]}<button class="rp-inline-link" onClick={() => setDialog("duplicate")}>{t("editor.code.duplicateIt")}</button>{readonlyNote()[1]}
            </span>
          </div>
        </Show>
        <Show when={conflict()}>
          <div class="status-block status-warn" role="alert">
            <TriangleAlert size={14} aria-hidden="true" />
            <span>
              {message()?.text}{" "}
              <button class="rp-inline-link" onClick={() => { const f = file(); if (f) openSource(f.id); }}>{t("editor.code.reload")}</button>
            </span>
          </div>
        </Show>

        <div class="code-frame" classList={{ readonly: !!file()?.readonly }}>
          <div class="code-bar">
            <span class="mono code-file">{file()?.file ?? "—"}</span>
            <Show when={dirty()}>
              <span class="code-dirty" title={t("editor.code.unsavedTitle")}><span class="code-dot" aria-hidden="true" /> {t("editor.code.unsaved")}</span>
            </Show>
            <span class="push note">{t("editor.code.saveHint", { key: SAVE_KEY })}</span>
          </div>
          <Show when={file() && !loading()} fallback={<div class="code-loading muted rs-inline"><LoaderCircle size={14} class="rs-spin" aria-hidden="true" /> {t("common.loading")}</div>}>
            <Suspense fallback={<div class="code-loading muted rs-inline"><LoaderCircle size={14} class="rs-spin" aria-hidden="true" /> {t("editor.code.loadingEditor")}</div>}>
              <CodeEditor ariaLabel={t("editor.code.sourceAria", { file: file()!.file })} />
            </Suspense>
          </Show>
        </div>

        <div class="cluster">
          <button class="btn btn-primary" onClick={save} disabled={!file() || file()!.readonly || saving() || (!dirty() && !conflict())}>
            <Show when={saving()} fallback={<Save size={14} aria-hidden="true" />}><LoaderCircle size={14} class="rs-spin" aria-hidden="true" /></Show>
            {conflict() ? t("editor.code.saveAnyway") : t("editor.code.savePreview")}
          </button>
          <Show when={dirty()}>
            <button class="btn btn-ghost btn-sm" onClick={async () => { const f = file(); if (f && await confirmDiscard()) openSource(f.id); }}>
              <RefreshCw size={14} aria-hidden="true" /> {t("editor.code.discard")}
            </button>
          </Show>
        </div>

        <Show when={message() && !conflict()}>
          <p class={`status-block status-${message()!.tone}`} role="status">
            <Show when={message()!.tone === "good"} fallback={<CircleAlert size={14} aria-hidden="true" />}><CircleCheck size={14} aria-hidden="true" /></Show>
            <span>{message()!.text}</span>
          </p>
        </Show>

        <Show when={err()}>
          {(e) => (
            <div class="code-error stack-sm" role="alert">
              <p class="mono code-error-msg">{e().message}</p>
              <Show when={e().location}>
                {(loc) => (
                  <button class="rp-inline-link mono" onClick={() => gotoLine(loc().line ?? 1)}>
                    {file()?.file}:{loc().line}{loc().function ? t("editor.code.inFunction", { fn: loc().function }) : ""} — {t("editor.code.goToLine")}
                  </button>
                )}
              </Show>
              <Show when={e().location?.text}>
                <pre class="code code-snippet">{e().location!.text}</pre>
              </Show>
              <Show when={e().traceback}>
                <details>
                  <summary class="note">Traceback</summary>
                  <pre class="code code-snippet">{e().traceback}</pre>
                </details>
              </Show>
            </div>
          )}
        </Show>
      </section>

      <Show when={file() && !file()!.readonly}>
        <section class="section">
          <h3 class="section-label"><History size={14} aria-hidden="true" /> {t("editor.code.versions")}</h3>
          <Show when={versions().length} fallback={<p class="note">{t("editor.code.versionsNote")}</p>}>
            <ul class="code-versions">
              <For each={versions()}>
                {(v) => (
                  <li>
                    <span class="mono">{prettyVersion(v.version)}</span>
                    <span class="muted mono">{t("editor.code.lines", { count: v.lines })}</span>
                    <button class="btn btn-ghost btn-sm push" onClick={() => loadVersion(v.version)} aria-label={t("editor.code.loadAria", { time: prettyVersion(v.version) })}>
                      {t("editor.code.load")}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </Show>
    </div>
  );
}
