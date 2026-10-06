import { createEffect, createSignal, createUniqueId, ErrorBoundary, type JSX, on, Show, Suspense } from "solid-js";
import { bundle } from "../state";
import { CircleAlert, RotateCcw, X } from "lucide-solid";
import { localeTag, t } from "../i18n";
import { useModal } from "../lib/dialog";

/**
 * Error containment for one region of the app (3D view, dock, side panels, drawing, array tab) or one dialog.
 * A render error inside `children` shows a compact, honest fallback in place of that region only;
 * "Reload panel" re-mounts it, and so does opening another project. Also the Suspense boundary for
 * lazily loaded regions. A dialog passes `onClose`: its error then shows in the dialog's place, as a
 * modal that the close button, Escape or a click outside closes (closing the dialog itself).
 */
export default function PanelBoundary(props: { name: string; children: JSX.Element; class?: string; loading?: JSX.Element; onClose?: () => void }) {
  return (
    <ErrorBoundary fallback={(err, reset) => <PanelError name={props.name} error={err} reset={reset} class={props.class} onClose={props.onClose} />}>
      <Suspense fallback={props.loading ?? <div class={`panel-loading ${props.class ?? ""}`} role="status">{t("panel.loading", { name: props.name.toLocaleLowerCase(localeTag()) })}</div>}>
        {props.children}
      </Suspense>
    </ErrorBoundary>
  );
}

function PanelError(props: { name: string; error: unknown; reset: () => void; class?: string; onClose?: () => void }) {
  const [open, setOpen] = createSignal(false);
  const err = () => (props.error instanceof Error ? props.error : new Error(String(props.error)));
  // also on the console, with the stack, for bug reports
  console.error(`[fairbeam] ${props.name} failed to render`, props.error);
  // opening another project re-mounts the panel by itself (the error was likely in the old data)
  createEffect(on(bundle, () => props.reset(), { defer: true }));
  const titleId = createUniqueId();
  const content = (close?: () => void) => (
    <>
      <p class="panel-error-title">
        <CircleAlert size={14} aria-hidden="true" />
        <span id={titleId}>
          {t("panel.failed", { name: props.name })} <span class="mono">{err().message || err().name}</span>
        </span>
        {close && <button class="icon-btn panel-error-close" onClick={() => close()} aria-label={t("common.close")}><X size={16} aria-hidden="true" /></button>}
      </p>
      <p class="panel-error-hint">{t("panel.hint")}</p>
      <div class="cluster">
        <button class="btn btn-ghost btn-sm" onClick={() => props.reset()}>
          <RotateCcw size={14} aria-hidden="true" /> {t("panel.reload")}
        </button>
        <button class="btn btn-ghost btn-sm" aria-expanded={open()} onClick={() => setOpen(!open())}>
          {open() ? t("panel.hideDetails") : t("panel.details")}
        </button>
      </div>
      <Show when={open()}>
        <pre class="code panel-error-stack" tabindex={0}>{err().stack ?? String(props.error)}</pre>
      </Show>
    </>
  );
  return (
    <Show when={props.onClose} fallback={<div class={`panel-error ${props.class ?? ""}`} role="alert">{content()}</div>}>
      {(close) => <DialogError labelledBy={titleId} close={close()}>{content(close())}</DialogError>}
    </Show>
  );
}

/** a failed dialog's error, in the dialog's place: modal (focus, Escape, background inert) and closable */
function DialogError(props: { labelledBy: string; close: () => void; children: JSX.Element }) {
  let dialog!: HTMLDivElement;
  useModal(() => dialog, () => props.close());
  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && props.close()}>
      <div class="panel-error panel-error-dialog" role="alertdialog" aria-modal="true" aria-labelledby={props.labelledBy} tabindex={-1} ref={dialog}>
        {props.children}
      </div>
    </div>
  );
}
