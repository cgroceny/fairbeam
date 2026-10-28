import { createSignal, Show } from "solid-js";
import { CircleAlert, LoaderCircle, X } from "lucide-solid";
import { useModal } from "../lib/dialog";
import OptimizePanel from "../runner/OptimizePanel";
import { t } from "../i18n";
import type { Job, OptGoal } from "../runner/api";
import { prepareRequirementGoals } from "../runner/optimize";
import { attachDesignOptimize, optimizeDialogOpen, prepareDesignSubmission, setOptimizeDialogOpen, setDesignDockTab } from "../runner/designRun";

const [opening, setOpening] = createSignal(false);
const [openError, setOpenError] = createSignal<string | null>(null);
let preparation = 0;
let pendingRequirements: OptGoal[] | undefined;
const close = () => { preparation++; setOpening(false); setOptimizeDialogOpen(false); };

/** Save/check the current document, then open the shared runner optimizer for its fresh model. */
export async function openDesignerOptimize(requirementGoals?: OptGoal[]) {
  if (opening()) return;
  pendingRequirements = requirementGoals ? structuredClone(requirementGoals) : undefined;
  const mine = ++preparation;
  const isCurrent = () => mine === preparation && optimizeDialogOpen();
  setOpening(true);
  setOpenError(null);
  setOptimizeDialogOpen(true);
  try {
    const prepared = await prepareDesignSubmission(isCurrent);
    if (isCurrent()) {
      const error = prepared.error ?? (prepared.target?.isCurrent() ? null : t("runner.optimize.notSaved"));
      if (!error && pendingRequirements) prepareRequirementGoals(pendingRequirements);
      setOpenError(error);
    }
  } catch (e) {
    if (isCurrent()) setOpenError(e instanceof Error ? e.message : String(e));
  } finally { if (mine === preparation) setOpening(false); }
}

export default function OptimizeDialog() {
  return <Show when={optimizeDialogOpen()}><OptimizeDialogContent /></Show>;
}

function OptimizeDialogContent() {
  let box: HTMLDivElement | undefined;
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
            <p class="muted">{t("opt.dialog.subtitle")}</p>
          </div>
          <button class="icon-btn" onClick={close} aria-label={t("common.close")}><X size={16} /></button>
        </div>
        <div class="rd-body" aria-busy={opening()}>
          <Show when={opening()}><p class="note" role="status"><LoaderCircle size={14} class="rs-spin" aria-hidden="true" /> {t("opt.dialog.preparing")}</p></Show>
          <Show when={!opening() && openError()}><div class="status-block status-critical" role="alert"><CircleAlert size={14} aria-hidden="true" /><div>
            <p>{openError()}</p><button class="btn btn-ghost btn-sm" onClick={() => void openDesignerOptimize(pendingRequirements)}>{t("opt.dialog.retry")}</button>
          </div></div></Show>
          <Show when={!opening() && !openError()}><OptimizePanel onStarted={started} /></Show>
        </div>
      </div>
    </div>
  </>;
}
