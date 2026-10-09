import { createMemo, createSignal, For, Show } from "solid-js";
import { ArrowDown, ArrowUp, ChevronRight, GitCompareArrows, Square, Trash2, TriangleAlert } from "lucide-solid";
import { num, seconds } from "../lib/format";
import { api, isTerminal, type Job, type JobStatus } from "./api";
import { loadIndex as loadIndexQuiet } from "../state";
import { attach, jobs, live, openResult, refreshRuns, setSubmitError } from "./store";
import { ago, paramSummary, StatusBadge } from "./status";
import { cancelSweep, historyItems, sweepLongCsv, summaryRows, type SummaryRow, type SweepGroup } from "./sweep";
import { saveDownload } from "../lib/download";
import { useModal } from "../lib/dialog";
import SweepSummaryMulti, { isMultiPortGroup } from "./SweepSummaryMulti";
import { ClearQueueButton, engineThreadsText, jobName, QueueButton } from "./RunQueue";
import { t } from "../i18n";

type StatusFilter = "all" | "active" | "done" | "failed" | "stopped";
/** label: an i18n key */
const STATUS_FILTERS: { id: StatusFilter; label: string; match: (s: JobStatus) => boolean }[] = [
  { id: "all", label: "runHistory.filter.all", match: () => true },
  { id: "active", label: "runHistory.filter.active", match: (s) => !isTerminal(s) },
  { id: "done", label: "progress.status.done", match: (s) => s === "done" },
  { id: "failed", label: "progress.status.failed", match: (s) => s === "failed" },
  { id: "stopped", label: "runHistory.filter.stopped", match: (s) => s === "cancelled" || s === "interrupted" },
];
const runName = (sweep: unknown, index: number) =>
  (sweep as { sequence_name?: string })?.sequence_name ?? t("progress.runN", { n: (sweep as { sequence_index?: number })?.sequence_index ?? index + 1 });

function action(j: Job): { label: string; run: () => void } {
  const name = jobName(j);
  if (j.status === "done" && j.bundle) return { label: t("runHistory.openResultsOf", { name }), run: () => openResult(j.bundle!) };
  return { label: t(isTerminal(j.status) ? "runHistory.showRun" : "runHistory.followRun", { status: t(`progress.status.${j.status}`), name }), run: () => attach(j) };
}

function groupStatus(g: SweepGroup): JobStatus {
  if (g.active) return g.jobs.some((j) => j.status === "running") ? "running" : "queued";
  if (g.jobs.every((j) => j.status === "done")) return "done";
  if (g.jobs.some((j) => j.status === "failed")) return "failed";
  return "cancelled";
}

/** Inline confirmation for removing runs from the history (and optionally their project files). */
function DeleteConfirm(props: { targets: Job[]; onDone: () => void }) {
  const [alsoBundle, setAlsoBundle] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const deletable = () => props.targets.filter((j) => isTerminal(j.status));
  const withBundle = () => deletable().filter((j) => j.bundle).length;
  const remove = async () => {
    setBusy(true);
    try {
      let bundles = 0;
      for (const j of deletable()) {
        const r = await api.deleteRun(j.id, alsoBundle());
        if (r.bundle_deleted) bundles++;
      }
      if (bundles) await loadIndexQuiet();
      await refreshRuns();
      props.onDone();
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="rp-confirm stack-sm" role="group" aria-label={t("runHistory.removeTitle")}>
      <p class="rp-small">
        {t("runHistory.removeConfirm", { count: deletable().length })} <span class="mono">.sim/jobs</span>{t("runHistory.removeConfirmEnd")}
      </p>
      <Show when={withBundle()}>
        <label class="toggle">
          <input type="checkbox" checked={alsoBundle()} onChange={(e) => setAlsoBundle(e.currentTarget.checked)} />
          <span class="toggle-box" aria-hidden="true" />
          <span class="rp-small">{t("runHistory.alsoDelete", { count: withBundle() })}</span>
        </label>
      </Show>
      <div class="cluster-sm">
        <button class="btn btn-ghost btn-sm" onClick={remove} disabled={busy() || !deletable().length}>
          <Trash2 size={14} aria-hidden="true" /> {t("common.remove")}
        </button>
        <button class="btn btn-ghost btn-sm" onClick={props.onDone} ref={(el) => queueMicrotask(() => el.focus())}>{t("runHistory.keep")}</button>
      </div>
    </div>
  );
}

function JobRow(props: { job: Job; inSweep?: boolean }) {
  const j = () => props.job;
  const [confirm, setConfirm] = createSignal(false);
  const a = () => action(j());
  return (
    <li class="rp-hrow-wrap">
      <div class="rp-hrow">
        <button class="rp-hrow-main" classList={{ active: live.job?.id === j().id }} onClick={() => a().run()} aria-label={a().label} title={j().error ?? j().bundle ?? j().id}>
          <StatusBadge status={j().status} compact />
          <span class="rp-hrow-text">
            <span class="rp-hrow-name">
              <Show when={props.inSweep} fallback={<><span class="mono">{jobName(j())}</span> <Show when={j().kind !== "research"}><span class="muted">{paramSummary(j())}</span></Show></>}>
                <span class="mono">{runName(j().sweep, j().sweep!.index)} · {Object.entries(j().sweep!.values).map(([k, v]) => `${k}=${v}`).join(", ")}</span>
              </Show>
            </span>
            <span class="rp-hrow-sub mono">
              {ago(j().created)}
              <Show when={j().duration_s !== null && isTerminal(j().status)}> · {seconds(j().duration_s)}</Show>
              <Show when={j().kind !== "research"}>{" · "}{engineThreadsText(j().engine, j().info?.threads ?? j().threads, true)}</Show>
            </span>
          </span>
        </button>
        <Show when={isTerminal(j().status)}>
          <button class="icon-btn icon-btn-sm" onClick={() => setConfirm(!confirm())} aria-expanded={confirm()} aria-label={t("runHistory.removeRun", { name: j().label ?? j().model })} title={t("runHistory.removeTitle")}>
            <Trash2 size={14} />
          </button>
        </Show>
        {/* a waiting run leaves the queue, the running one stops, from its own row (#8) */}
        <QueueButton job={j()} compact />
      </div>
      <Show when={confirm()}>
        <DeleteConfirm targets={[j()]} onDone={() => setConfirm(false)} />
      </Show>
    </li>
  );
}

type SortKey = string;

export function SweepSummary(props: { group: SweepGroup; onOpenRun?: (file: string) => void }) {
  const [sort, setSort] = createSignal<{ key: SortKey; dir: 1 | -1 }>({ key: "_index", dir: 1 });
  const cols = () => [
    ...props.group.keys.map((k) => ({ key: `p:${k}`, label: k, unit: "", get: (r: SummaryRow) => r.values[k] ?? null, digits: 3 })),
    { key: "f", label: t("runHistory.col.bestMatch"), unit: "GHz", get: (r: SummaryRow) => r.fBest, digits: 3 },
    { key: "s11", label: "|S11| min", unit: "dB", get: (r: SummaryRow) => r.s11Min, digits: 1 },
    { key: "dmax", label: "Dmax", unit: "dBi", get: (r: SummaryRow) => r.dmax, digits: 2 },
    // the radiation efficiency (the far field's), named so it is not read as the Runs table's total
    // efficiency; a value above 100 % is flagged: the far field of that run is not physical
    { key: "eff", label: t("runHistory.col.radEff"), unit: "%", get: (r: SummaryRow) => (r.eff === null ? null : r.eff * 100), digits: 1 },
  ];
  const over = (key: string, v: number | null) => key === "eff" && v !== null && v > 100;
  const copyData = async () => { await navigator.clipboard.writeText(sweepLongCsv(props.group)); };
  const exportCsv = async () => { await saveDownload(`${props.group.name.replace(/[^\w.-]+/g, "-")}-results.csv`, sweepLongCsv(props.group), "text/csv;charset=utf-8"); };
  const rows = createMemo(() => {
    const list = summaryRows(props.group);
    const s = sort();
    if (s.key === "_index") return s.dir === 1 ? list : [...list].reverse();
    const col = cols().find((c) => c.key === s.key);
    if (!col) return list;
    return [...list].sort((a, b) => {
      const va = col.get(a);
      const vb = col.get(b);
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * s.dir;
    });
  });
  const toggle = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  return (
    <div class="rp-summary">
      <div class="cluster-sm">
        <button class="btn btn-ghost btn-sm" onClick={copyData}>{t("results.toolbar.copyData")}</button>
        <button class="btn btn-ghost btn-sm" onClick={exportCsv}>{t("runHistory.exportCsv")}</button>
        <span class="rp-small muted">{t("runHistory.allRunsNote", { count: props.group.jobs.length })}</span>
      </div>
      <table class="table">
        <caption>{t("runHistory.summaryCaption")}</caption>
        <thead>
          <tr>
            <th>{t("runHistory.sequence")}</th><th>{t("runHistory.status")}</th>
            <For each={cols()}>
              {(c) => (
                <th class="num" aria-sort={sort().key === c.key ? (sort().dir === 1 ? "ascending" : "descending") : "none"}>
                  <button class="rp-sort" onClick={() => toggle(c.key)}>
                    {c.label}
                    <Show when={sort().key === c.key}>
                      <Show when={sort().dir === 1} fallback={<ArrowDown size={12} aria-hidden="true" />}><ArrowUp size={12} aria-hidden="true" /></Show>
                    </Show>
                    <Show when={c.unit}><span class="th-unit">{c.unit}</span></Show>
                  </button>
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={rows()}>
            {(r) => {
              const open = () => (r.job.status === "done" && r.job.bundle ? props.onOpenRun ? props.onOpenRun(r.job.bundle) : openResult(r.job.bundle) : attach(r.job));
              return (
                <tr class="row-select" tabindex={0} onClick={open} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open())}>
                  <td>{runName(r.job.sweep, r.job.sweep!.index)}</td>
                  <td>{t(`progress.status.${r.job.status}`)}</td>
                  <For each={cols()}>{(c) => <td class="num" classList={{ "rp-over": over(c.key, c.get(r)) }} title={over(c.key, c.get(r)) ? t("runHistory.radEffOver") : undefined}>
                    <Show when={over(c.key, c.get(r))}><TriangleAlert size={11} aria-hidden="true" /> </Show>{c.get(r) === null ? "—" : num(c.get(r), c.digits)}</td>}</For>
                </tr>
              );
            }}
          </For>
        </tbody>
      </table>
    </div>
  );
}

export function SweepCompareView(props: { id: string; onClose: () => void; onOpenRun: (file: string) => void }) {
  let box: HTMLElement | undefined;
  useModal(() => box, props.onClose);
  const group = () => { const it = historyItems().find((entry) => entry.kind === "sweep" && entry.group.id === props.id); return it?.kind === "sweep" ? it.group : null; };
  return <Show when={group()}>{(g) => (
    <div class="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <section ref={box} class="dialog" role="dialog" aria-modal="true" aria-label={t("runHistory.compareAllAria", { name: g().name })} tabindex={-1}>
        <div class="dialog-head">
          <h2>{t("runHistory.compareAll")} · {g().name}</h2>
          <button class="btn btn-ghost btn-sm" onClick={props.onClose}>{t("common.close")}</button>
        </div>
        <div style={{ overflow: "auto", padding: "var(--al-space-4)" }}>
          <SweepSummary group={g()} onOpenRun={props.onOpenRun} />
          <Show when={isMultiPortGroup(g())}><SweepSummaryMulti group={g()} /></Show>
        </div>
      </section>
    </div>
  )}</Show>;
}

function SweepRow(props: { group: SweepGroup; open: boolean; onToggle: () => void }) {
  const g = () => props.group;
  const [confirm, setConfirm] = createSignal(false);
  const panelId = () => `sweep-${g().id}`;
  return (
    <li class="rp-hrow-wrap rp-sweep">
      <div class="rp-hrow">
        <button class="rp-hrow-main" onClick={props.onToggle} aria-expanded={props.open} aria-controls={panelId()}>
          <StatusBadge status={groupStatus(g())} compact />
          <span class="rp-hrow-text">
            <span class="rp-hrow-name">
              <ChevronRight size={12} class="rp-chevron" classList={{ open: props.open }} aria-hidden="true" />
              {g().name}
            </span>
            <span class="rp-hrow-sub mono">{ago(g().created)} · {t("progress.sweepDone", { done: g().done, total: g().total })} · {g().keys.join(" × ")}</span>
          </span>
        </button>
        <Show when={g().jobs.length > 0}>
          <button class="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); if (!props.open) props.onToggle(); }} title={t("runHistory.compareAllTitle", { count: g().jobs.length })}>
            <GitCompareArrows size={14} aria-hidden="true" /> {t("runHistory.compareAll")}
          </button>
        </Show>
        <Show when={!g().active}>
          <button class="icon-btn icon-btn-sm" onClick={() => setConfirm(!confirm())} aria-expanded={confirm()} aria-label={t("runHistory.removeSweep", { name: g().name })} title={t("runHistory.removeSweepTitle")}>
            <Trash2 size={14} />
          </button>
        </Show>
      </div>
      <Show when={confirm()}>
        <DeleteConfirm targets={g().jobs} onDone={() => setConfirm(false)} />
      </Show>
      <Show when={props.open}>
        <div class="rp-sweep-body stack" id={panelId()}>
          <div class="cluster-sm">
            <Show when={g().active}>
              <button class="btn btn-ghost btn-sm" onClick={() => cancelSweep(g().id)}>
                <Square size={12} aria-hidden="true" /> {t("runHistory.cancelSweep")}
              </button>
            </Show>
          </div>
          <SweepSummary group={g()} />
          <Show when={isMultiPortGroup(g())}>
            <SweepSummaryMulti group={g()} />
          </Show>
          <ul class="rp-hlist">
            <For each={g().jobs}>{(j) => <JobRow job={j} inSweep />}</For>
          </ul>
        </div>
      </Show>
    </li>
  );
}

export default function RunHistory() {
  const [model, setModel] = createSignal("all");
  const [status, setStatus] = createSignal<StatusFilter>("all");
  const [openSweeps, setOpenSweeps] = createSignal<Set<string>>(new Set());
  const modelsInHistory = () => [...new Set(jobs().map((j) => j.model_id ?? j.model))].sort();
  const matches = (j: Job) =>
    (model() === "all" || (j.model_id ?? j.model) === model()) && STATUS_FILTERS.find((f) => f.id === status())!.match(j.status);
  const items = () =>
    historyItems()
      .filter((it) => (it.kind === "job" ? matches(it.job) : it.group.jobs.some(matches)))
      .slice(0, 30);
  const toggleSweep = (id: string) => {
    const next = new Set(openSweeps());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenSweeps(next);
  };
  return (
    <section class="section rp-history" aria-label={t("runHistory.title")}>
      <div class="rp-label-row">
        <h3 class="section-label">{t("runHistory.title")}</h3>
        <ClearQueueButton />
      </div>
      <Show when={jobs().length} fallback={<p class="muted rp-small">{t("runHistory.empty")}</p>}>
        <div class="cluster-sm rp-filters">
          <select class="rp-select rp-select-sm" aria-label={t("runHistory.filterModel")} value={model()} onChange={(e) => setModel(e.currentTarget.value)}>
            <option value="all">{t("runHistory.allModels")}</option>
            <For each={modelsInHistory()}>{(m) => <option value={m}>{m}</option>}</For>
          </select>
          <select class="rp-select rp-select-sm" aria-label={t("runHistory.filterStatus")} value={status()} onChange={(e) => setStatus(e.currentTarget.value as StatusFilter)}>
            <For each={STATUS_FILTERS}>{(f) => <option value={f.id}>{t(f.label)}</option>}</For>
          </select>
        </div>
        <Show when={items().length} fallback={<p class="muted rp-small">{t("runHistory.noMatch")}</p>}>
          <ul class="rp-hlist">
            <For each={items()}>
              {(it) =>
                it.kind === "job" ? (
                  <JobRow job={it.job} />
                ) : (
                  <SweepRow group={it.group} open={openSweeps().has(it.group.id)} onToggle={() => toggleSweep(it.group.id)} />
                )
              }
            </For>
          </ul>
        </Show>
      </Show>
    </section>
  );
}
