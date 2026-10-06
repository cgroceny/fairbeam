import { Show } from "solid-js";
import { CircleCheck, Eye, FolderOpen, GitCompareArrows, LoaderCircle, TriangleAlert, Undo2 } from "lucide-solid";
import { appMode } from "../workspace";
import { notice, openBundlePath, openResult, previewActive, previewState, restoreProject, setNotice } from "./store";
import { paramSummary } from "./status";
import { compareSweep, historyItems, pickForCompare } from "./sweep";
import { t } from "../i18n";

/** Badge over the 3D view while it shows a geometry preview instead of a simulated project. */
export function PreviewBadge() {
  return (
    <Show when={previewActive() && appMode() !== "design"}>
      <div class="rs-preview-badge" role="status">
        <Show when={previewState() === "loading"} fallback={<Eye size={13} aria-hidden="true" />}>
          <LoaderCircle size={13} class="rs-spin" aria-hidden="true" />
        </Show>
        <span>{t("overlay.preview")} <span class="muted">{t("overlay.notSimulated")}</span></span>
        <button class="btn btn-ghost btn-sm" onClick={restoreProject} title={t("overlay.backTitle")}>
          <Undo2 size={12} /> {t("overlay.back")}
        </button>
      </div>
    </Show>
  );
}

/** Banner under the header when a run or a sweep finished: open or compare its results. */
export function RunNotice() {
  const run = () => {
    const n = notice();
    return n?.kind === "run" ? n : null;
  };
  const sweep = () => {
    const n = notice();
    return n?.kind === "sweep" ? n : null;
  };
  const opt = () => {
    const n = notice();
    return n?.kind === "optimize" ? n : null;
  };
  const sweepGroup = () => {
    const n = sweep();
    const it = n ? historyItems().find((i) => i.kind === "sweep" && i.group.id === n.sweepId) : undefined;
    return it?.kind === "sweep" ? it.group : null;
  };
  return (
    <>
      <Show when={run()}>
        {(r) => (
          <div class="banner rs-banner-good" role="status">
            <CircleCheck size={14} aria-hidden="true" />
            <span>
              {t("overlay.runFinished")} — <span class="mono">{r().job.label ?? r().job.model_id ?? r().job.model}</span> {paramSummary(r().job)}
              <span class="muted mono"> · {r().bundle}</span>
            </span>
            <button class="btn btn-ghost btn-sm" onClick={() => openResult(r().bundle)}>
              <FolderOpen size={14} aria-hidden="true" /> {t("overlay.openResults")}
            </button>
            <button class="btn btn-ghost btn-sm" onClick={() => setNotice(null)}>{t("overlay.dismiss")}</button>
          </div>
        )}
      </Show>
      <Show when={opt()}>
        {(o) => (
          <div class="banner rs-banner-good" role="status">
            <CircleCheck size={14} aria-hidden="true" />
            <span>
              {t("overlay.optFinished", { reason: o().reason })} — <span class="mono">{o().job.label ?? o().job.model}</span>
              <Show when={o().best}>
                <span class="muted mono"> · {t("overlay.best")} {Object.entries(o().best!).map(([k, v]) => `${k}=${v}`).join(", ")}</span>
              </Show>
            </span>
            <Show when={o().bestFile}>
              <button class="btn btn-ghost btn-sm" onClick={() => openBundlePath(o().bestFile!)}>
                <FolderOpen size={14} aria-hidden="true" /> {t("overlay.openBest")}
              </button>
            </Show>
            <button class="btn btn-ghost btn-sm" onClick={() => setNotice(null)}>{t("overlay.dismiss")}</button>
          </div>
        )}
      </Show>
      <Show when={sweep()}>
        {(w) => (
          <div class="banner" classList={{ "rs-banner-good": w().done === w().total, "banner-warn": w().done < w().total }} role="status">
            <Show when={w().done === w().total} fallback={<TriangleAlert size={14} aria-hidden="true" />}><CircleCheck size={14} aria-hidden="true" /></Show>
            <span>
              {w().done === w().total ? t("overlay.sweepFinished") : t("overlay.sweepEnded")} — {w().name}
              <span class="muted mono"> · {t("overlay.completed", { done: w().done, total: w().total })}</span>
            </span>
            <Show when={sweepGroup() && pickForCompare(sweepGroup()!).length > 1}>
              <button class="btn btn-ghost btn-sm" onClick={() => { compareSweep(sweepGroup()!); setNotice(null); }}>
                <GitCompareArrows size={14} aria-hidden="true" /> {t("overlay.compareAll")}
              </button>
            </Show>
            <button class="btn btn-ghost btn-sm" onClick={() => setNotice(null)}>{t("overlay.dismiss")}</button>
          </div>
        )}
      </Show>
    </>
  );
}
