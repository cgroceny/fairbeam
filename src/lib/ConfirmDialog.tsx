import { Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { useModal } from "./dialog";
import { t } from "../i18n";

type Request = { message: string; resolve: (discard: boolean) => void };
const [queue, setQueue] = createSignal<Request[]>([]);

/** Ask asynchronously whether an unsaved draft should be discarded. */
export function confirmDraftDiscard(message: string): Promise<boolean> {
  return new Promise((resolve) => setQueue((items) => [...items, { message, resolve }]));
}

export default function ConfirmDialog() {
  const current = () => queue()[0];
  return <Show when={current()}>{(request) => <ConfirmDialogView request={request()} />}</Show>;
}

function ConfirmDialogView(props: { request: Request }) {
  let dialog!: HTMLDivElement;
  let cancelButton!: HTMLButtonElement;
  const finish = (discard: boolean) => {
    const item = props.request;
    setQueue((items) => items.slice(1));
    item.resolve(discard);
  };
  useModal(() => dialog, () => finish(false), () => cancelButton);
  return (
    <Portal>
      <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && finish(false)}>
        <div ref={dialog} class="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-draft-title" aria-describedby="confirm-draft-message" tabindex="-1">
          <div class="dialog-head">
            <div><h2 id="confirm-draft-title">{t("confirm.discard.title")}</h2><p id="confirm-draft-message">{props.request.message}</p></div>
          </div>
          <div class="dialog-foot"><div class="dialog-actions">
            <button class="btn btn-ghost" onClick={() => finish(true)}>{t("confirm.discard.button")}</button>
            <button ref={cancelButton} class="btn btn-primary" onClick={() => finish(false)}>{t("common.cancel")}</button>
          </div></div>
        </div>
      </div>
    </Portal>
  );
}
