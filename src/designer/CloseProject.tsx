import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import { closeDesign, dirty, draft, file, message, releaseDraft, replaceRequest, type ReplaceRequest, saveAndCloseDesign, saveBeforeLeaving, saving } from "./store";

import { answerWindowClose, decideWindowClose, windowClose, type WindowLeave } from "./windowClose";
import { modifierShortcut } from "../lib/shortcut";
import { t } from "../i18n";

export const CLOSE_KEY = modifierShortcut("W");
const [requested, setRequested] = createSignal(false);

/** All entry points use this command; an existing modal must be completed first. */
export function requestCloseProject() {
  if (!file() || requested() || document.querySelector(".dialog")) return;
  if (dirty() || saving()) setRequested(true);
  else closeDesign();
}

interface UnsavedChoice {
  title: string;
  description: string;
  /** resolves true once the draft is saved and unchanged; false keeps the dialog open */
  save: () => Promise<boolean>;
  discard: () => void;
  cancel: () => void;
  /** Escape is taken before other open modals (the New model dialog stays behind this one) */
  captureEscape?: boolean;
}

/** Save / Don't save / Cancel for the open draft: closing it, or replacing it with another design. */
function UnsavedChangesDialog(props: UnsavedChoice) {
  let dialog!: HTMLDivElement;
  let cancelButton!: HTMLButtonElement;
  // a save already running when the dialog opened reports its outcome here too
  const [attempted, setAttempted] = createSignal(saving());
  const cancel = () => { if (!saving()) props.cancel(); };
  useModal(() => dialog, cancel, () => cancelButton);
  onMount(() => {
    if (!props.captureEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });
  const save = async () => {
    setAttempted(true);
    await props.save();
  };
  return (
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && cancel()}>
      <div ref={dialog} class="dialog close-project-dialog" role="dialog" aria-modal="true" aria-labelledby="close-project-title"
        aria-describedby="close-project-description" tabindex="-1">
        <div class="dialog-head">
          <div>
            <h2 id="close-project-title">{props.title}</h2>
            <p id="close-project-description">{props.description}</p>
          </div>
          <button class="icon-btn" onClick={cancel} disabled={saving()} aria-label={t("common.cancel")} data-noprompt><X size={16} /></button>
        </div>
        <Show when={attempted() && message()}>
          <p class={`dz-msg dz-msg-${message()!.tone}`} role="status">{message()!.text}</p>
        </Show>
        <div class="dialog-foot">
          <div class="dialog-actions">
            <button class="btn btn-ghost" disabled={saving()} onClick={() => props.discard()} data-noprompt>{t("closeProject.dontSave")}</button>
            <button ref={cancelButton} class="btn" disabled={saving()} onClick={cancel} data-noprompt>{t("common.cancel")}</button>
            <button class="btn btn-primary" disabled={saving()} onClick={save}>{saving() ? t("closeProject.saving") : t("common.save")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const draftName = () => draft.model?.name || file()?.file || t("closeProject.openDesign");

function CloseProjectDialog() {
  return (
    <UnsavedChangesDialog
      title={t("closeProject.close.title")}
      description={t("closeProject.close.description", { name: draftName() })}
      save={async () => {
        const ok = await saveAndCloseDesign();
        if (ok) setRequested(false);
        return ok;
      }}
      discard={() => { setRequested(false); closeDesign(); }}
      cancel={() => setRequested(false)}
    />
  );
}

/** Creating or opening another design replaces the open draft: the same choice, then it goes on. */
function ReplaceProjectDialog(props: { request: ReplaceRequest }) {
  const request = props.request;
  let settled = false;
  const decide = (proceed: boolean) => {
    if (settled) return;
    settled = true;
    request.decide(proceed);
  };
  // a save started before the request finished cleanly: nothing is at stake any more
  createEffect(() => { if (!saving() && !dirty()) decide(true); });
  // the dialog went away without a choice (the design was closed or deleted meanwhile)
  onCleanup(() => decide(!file()));
  return (
    <UnsavedChangesDialog
      title={t(request.action === "create" ? "closeProject.replace.createTitle" : "closeProject.replace.openTitle", { target: request.target })}
      description={t("closeProject.replace.description", { name: draftName() })}
      save={async () => {
        const ok = await saveBeforeLeaving();
        if (ok) decide(true);
        return ok;
      }}
      discard={() => { releaseDraft(); decide(true); }}
      cancel={() => decide(false)}
      captureEscape
    />
  );
}

/** Closing the desktop window or quitting (windowClose.ts): the same choice, then the app goes. */
function WindowCloseDialog(props: { kind: WindowLeave }) {
  // a save running when the question came finished cleanly: nothing is at stake any more
  createEffect(() => { if (!file() || (!saving() && !dirty())) decideWindowClose("close"); });
  const quitting = () => props.kind === "quit";
  return (
    <UnsavedChangesDialog
      title={t(quitting() ? "closeProject.quit.title" : "closeProject.window.title")}
      description={t(quitting() ? "closeProject.quit.description" : "closeProject.window.description", { name: draftName() })}
      save={async () => {
        const ok = await saveBeforeLeaving();
        if (ok) decideWindowClose("close");
        return ok;
      }}
      // Don't save: like Close project, the draft and its local backup go
      discard={() => { closeDesign(); decideWindowClose("close"); }}
      cancel={() => decideWindowClose("cancel")}
      captureEscape
    />
  );
}

/** Mounted above workspace modes so File > Close also works after visiting Results or Start. */
export default function CloseProjectHost() {
  onMount(() => {
    const onClose = (event: Event) => {
      if (!file()) return;
      // Tell the native menu that a project owns this command, even while a dialog is open.
      event.preventDefault();
      requestCloseProject();
    };
    window.addEventListener("fairbeam:close-project", onClose);
    onCleanup(() => window.removeEventListener("fairbeam:close-project", onClose));
    // the desktop shell asks before its window closes or the app quits (src-tauri/src/main.rs)
    const w = window as Window & { fairbeamWindowClose?: typeof answerWindowClose };
    w.fairbeamWindowClose = answerWindowClose;
    onCleanup(() => { if (w.fairbeamWindowClose === answerWindowClose) delete w.fairbeamWindowClose; });
  });
  // closing the window replaces an open "Save changes before closing?" about the project
  createEffect(() => { if (windowClose()) setRequested(false); });
  return (
    <>
      <Show when={requested() && file()}><CloseProjectDialog /></Show>
      <Show when={windowClose()}>{(request) => <Portal><WindowCloseDialog kind={request().kind} /></Portal>}</Show>
      {/* in <body>, after every other modal: the New model dialog stays behind it */}
      <Show when={replaceRequest()} keyed>{(request) => <Portal><ReplaceProjectDialog request={request} /></Portal>}</Show>
    </>
  );
}
