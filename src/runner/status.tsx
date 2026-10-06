import { Match, Switch } from "solid-js";
import { Ban, CircleCheck, CircleX, Clock, LoaderCircle, TriangleAlert } from "lucide-solid";
import type { Job, JobStatus } from "./api";
import { fmt, t } from "../i18n";

const TONE: Record<JobStatus, string> = {
  queued: "rs-status-neutral",
  running: "rs-status-running",
  done: "status-good",
  failed: "status-critical",
  cancelled: "rs-status-neutral",
  interrupted: "status-warn",
};

/** i18n keys */
const LABEL: Record<JobStatus, string> = {
  queued: "progress.status.queued",
  running: "progress.status.running",
  done: "progress.status.done",
  failed: "progress.status.failed",
  cancelled: "progress.status.cancelled",
  interrupted: "progress.status.interrupted",
};

/** Job status: always an icon plus a text label (docs/DESIGN.md, status colours). */
export function StatusBadge(props: { status: JobStatus; compact?: boolean }) {
  return (
    <span class={`status ${TONE[props.status]}`} classList={{ "rs-status-compact": !!props.compact }}>
      <Switch>
        <Match when={props.status === "queued"}><Clock size={12} aria-hidden="true" /></Match>
        <Match when={props.status === "running"}><LoaderCircle size={12} class="rs-spin" aria-hidden="true" /></Match>
        <Match when={props.status === "done"}><CircleCheck size={12} aria-hidden="true" /></Match>
        <Match when={props.status === "failed"}><CircleX size={12} aria-hidden="true" /></Match>
        <Match when={props.status === "cancelled"}><Ban size={12} aria-hidden="true" /></Match>
        <Match when={props.status === "interrupted"}><TriangleAlert size={12} aria-hidden="true" /></Match>
      </Switch>
      {t(LABEL[props.status])}
    </span>
  );
}

/** "length=60, gap=0.5" or "defaults" */
export function paramSummary(job: Pick<Job, "overrides">): string {
  const o = Object.entries(job.overrides ?? {});
  return o.length ? o.map(([k, v]) => `${k}=${v}`).join(", ") : t("progress.defaults");
}

export function ago(unix: number | null | undefined): string {
  if (!unix) return "";
  const s = Date.now() / 1000 - unix;
  if (s < 60) return t("runHistory.justNow");
  if (s < 3600) return t("runHistory.minAgo", { n: Math.floor(s / 60) });
  if (s < 86400) return t("runHistory.hAgo", { n: Math.floor(s / 3600) });
  return fmt.date(unix * 1000, { day: "numeric", month: "short" });
}
