// The server's queue, whoever filled it: Stop for the running run and
// "Remove from queue" for a waiting one, on the Run panel's Recent runs rows (QueueButton) and in the
// designer dock's Queue tab (RunQueue), with "Clear queue". Every action calls the server's cancel
// (POST /api/runs/{id}/cancel, /api/queue/clear) and then shows the new state (store.ts cancelJob).
import { createMemo, createSignal, For, Show } from "solid-js";
import { Eye, ListX, Square, X } from "lucide-solid";
import { isTerminal, type Job } from "./api";
import { cancelJob, clearQueue, jobs, live, serverActivity, stopping } from "./store";
import { ago, paramSummary, StatusBadge } from "./status";
import { t } from "../i18n";

export const jobName = (j: Job) => j.kind === "research" ? `${t("research.title")} · ${t(`research.backend.${j.research?.backend ?? "periodic"}`)}` : j.label ?? j.model_id ?? j.model;

/** A run's engine and threads as its row says it: "GPU" for a GPU run (its solver does not use a
 * thread count, the job's 1 is a placeholder), else "CPU · 2 threads" ("CPU · Auto" before the run
 * reports the count Auto chose). `short`: the list rows' "2 thr". */
export function engineThreadsText(engine: string | null | undefined, threads: number | null | undefined, short = false): string {
  if (engine === "gpu") return "GPU";
  const n = typeof threads === "number" && threads > 0 ? threads : null;
  const count = n === null ? t("run.threads.auto") : short ? t("runHistory.threadsShort", { n }) : t("runDock.threads", { count: n });
  return `CPU · ${count}`;
}

/** Queued and running runs: the running one first, then the waiting ones in the order they start. */
export const activeRuns = () => jobs().filter((j) => !isTerminal(j.status))
  .sort((a, b) => (a.status === "running" ? 0 : 1) - (b.status === "running" ? 0 : 1) || a.created - b.created);

/** Stop (a running run) or Remove from queue (a waiting one). `compact`: an icon button for a list
 * row (the label is its accessible name and tooltip). Nothing for a finished run. */
export function QueueButton(props: { job: Job; compact?: boolean }) {
  const [busy, setBusy] = createSignal(false);
  const running = () => props.job.status === "running";
  /** asked to stop, its process has not exited yet */
  const ending = () => stopping().has(props.job.id);
  const label = () => t(ending() ? "runQueue.stopping" : running() ? "runQueue.stop" : "runQueue.remove");
  const aria = () => t(running() ? "runQueue.stopRun" : "runQueue.removeRun", { name: jobName(props.job) });
  const act = async (e: MouseEvent) => {
    e.stopPropagation();
    if (busy() || ending()) return;
    setBusy(true);
    try {
      await cancelJob(props.job.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show when={!isTerminal(props.job.status)}>
      <Show when={props.compact} fallback={
        <button type="button" class="btn btn-ghost btn-sm" data-queue-action={running() ? "stop" : "remove"} disabled={busy() || ending()} onClick={act}
          aria-label={aria()} title={t(running() ? "runQueue.stop.title" : "runQueue.remove.title")}>
          <Show when={running()} fallback={<X size={13} aria-hidden="true" />}><Square size={12} aria-hidden="true" /></Show> {label()}
        </button>
      }>
        <button type="button" class="icon-btn icon-btn-sm" data-queue-action={running() ? "stop" : "remove"} disabled={busy() || ending()} onClick={act}
          aria-label={ending() ? label() : aria()} title={ending() ? label() : t(running() ? "runQueue.stop.title" : "runQueue.remove.title")}>
          <Show when={running()} fallback={<X size={14} />}><Square size={13} /></Show>
        </button>
      </Show>
    </Show>
  );
}

/** "Clear queue (n)": takes every waiting run out of the queue; the running run goes on. */
export function ClearQueueButton() {
  const [busy, setBusy] = createSignal(false);
  const waiting = () => serverActivity().queued;
  return (
    <Show when={waiting() > 0}>
      <button type="button" class="btn btn-ghost btn-sm" data-queue-action="clear" disabled={busy()} title={t("runQueue.clear.title")}
        onClick={async () => { setBusy(true); try { await clearQueue(); } finally { setBusy(false); } }}>
        <ListX size={13} aria-hidden="true" /> {t("runQueue.clear", { count: waiting() })}
      </button>
    </Show>
  );
}

/** The designer dock's Queue tab: every queued or running run of the server (also runs of other
 * models, and runs a terminal or another window started), each with Follow and Stop / Remove from
 * queue. `followed`: the id the dock's Run tab shows; `onFollow`: show a run there. */
export function RunQueue(props: { followed: string | null; onFollow: (job: Job) => void }) {
  const rows = createMemo(activeRuns);
  return (
    <div class="rq">
      <div class="cluster-sm rq-head">
        <p class="rdk-key-note rq-note">
          {t("runQueue.note", { running: rows().filter((j) => j.status === "running").length, queued: serverActivity().queued })}
        </p>
        <ClearQueueButton />
      </div>
      <Show when={serverActivity().external > 0}>
        <p class="note rq-note">{t("runPanel.externalRuns", { count: serverActivity().external })}</p>
      </Show>
      <Show when={rows().length} fallback={<div class="panel-empty">{t("runQueue.empty")}</div>}>
        <ul class="rp-hlist rq-list" aria-label={t("runQueue.label")}>
          <For each={rows()}>{(j) => (
            <li class="rp-hrow-wrap">
              <div class="rp-hrow" classList={{ "rq-followed": props.followed === j.id }}>
                <span class="rp-hrow-main rq-main">
                  <StatusBadge status={j.status} compact />
                  <span class="rp-hrow-text">
                    <span class="rp-hrow-name"><span class="mono">{jobName(j)}</span> <Show when={j.kind !== "research"}><span class="muted">{paramSummary(j)}</span></Show></span>
                    <span class="rp-hrow-sub mono">{ago(j.created)}<Show when={j.kind !== "research"}>{" · "}{engineThreadsText(j.engine, j.info?.threads ?? j.threads, true)}</Show></span>
                  </span>
                </span>
                <Show when={props.followed !== j.id || live.job?.id !== j.id}>
                  <button type="button" class="btn btn-ghost btn-sm" onClick={() => props.onFollow(j)} title={t("runQueue.follow.title", { name: jobName(j) })}>
                    <Eye size={13} aria-hidden="true" /> {t("runQueue.follow")}
                  </button>
                </Show>
                <QueueButton job={j} />
              </div>
            </li>
          )}</For>
        </ul>
      </Show>
    </div>
  );
}
