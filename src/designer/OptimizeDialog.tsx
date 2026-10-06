import { createSignal, Show } from "solid-js";
import { X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import OptimizePanel from "../runner/OptimizePanel";
import { t } from "../i18n";
import type { Job } from "../runner/api";
import { attachDesignOptimize, optimizeDialogOpen, prepareDesignOptimize, setOptimizeDialogOpen, setDesignDockTab } from "../runner/designRun";

const [opening, setOpening] = createSignal(false);
const [openError, setOpenError] = createSignal<string | null>(null);

/** Save/check the current document, then open the shared runner optimizer for its fresh model. */
export async function openDesignerOptimize() {
  if (opening()) return;
  setOpening(true);
  setOpenError(null);
  try {
    const error = await prepareDesignOptimize();
    if (error) { setOpenError(error); setOptimizeDialogOpen(true); return; }
    setOptimizeDialogOpen(true);
  } catch (e) {
    setOpenError(e instanceof Error ? e.message : String(e));
    setOptimizeDialogOpen(true);
  } finally { setOpening(false); }
}

export default function OptimizeDialog() {
  return <Show when={optimizeDialogOpen()}><OptimizeDialogContent /></Show>;
}

function OptimizeDialogContent() {
  let box: HTMLDivElement | undefined;
  const close = () => setOptimizeDialogOpen(false);
  useModal(() => box, close, () => box?.querySelector<HTMLElement>("select"));
  const started = (job: Job) => {
    attachDesignOptimize(job);
    setDesignDockTab("run");
    close();
  };
  return <>
    <div class="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div class="dialog dialog-sm rd-dialog" role="dialog" aria-modal="true" aria-labelledby="od-title" ref={box} tabindex={-1}>
        <div class="dialog-head">
          <div>
            <h2 id="od-title">{t("opt.dialog.title")}</h2>
            <p class="muted">{openError() ?? t("opt.dialog.subtitle")}</p>
          </div>
          <button class="icon-btn" onClick={close} aria-label={t("common.close")}><X size={16} /></button>
        </div>
        <div class="rd-body"><Show when={!openError()}><OptimizePanel onStarted={started} /></Show></div>
      </div>
    </div>
  </>;
}
