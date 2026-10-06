// "Measured on other machines" in the Run section: the measured solver times of the open model on the
// reference machines (public/benchmarks.json, written by scripts/build-benchmarks.mjs from
// docs/BENCHMARKS.md, docs/GPU.md, docs/benchmarks/*.json and the committed bundles). Measurements
// only; hidden when the model has none or the file is missing.

import { createMemo, createSignal, For, Show } from "solid-js";
import type { Bundle } from "../types";
import { publicUrl } from "../env";
import { benchView, engineText, rowTitle, shortMachine, timestepsText, type BenchFile, type BenchRow, type BenchView } from "../lib/benchmarks";
import { fmt, t } from "../i18n";

const [file, setFile] = createSignal<BenchFile | null>(null);
let requested = false;
function load() {
  if (requested) return;
  requested = true;
  fetch(publicUrl("benchmarks.json"), { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: BenchFile | null) => d && typeof d.models === "object" && setFile(d))
    .catch(() => {
      /* no measurements in this build: the table stays hidden */
    });
}

// no trailing zeros: a doc value of 1.6 s stays 1.6, not 1.60
const time = (s: number) => fmt.intl(s, { maximumFractionDigits: s < 10 ? 2 : s < 100 ? 1 : 0 });
const mcells = (v: number | null) => (v === null ? "—" : fmt.intl(v, { maximumFractionDigits: 0 }));

const ports = (v: BenchView) => Math.max(0, ...[...v.rows.map((r) => r.row), ...(v.thisRun ? [v.thisRun] : [])].map((r) => r.timesteps?.length ?? 0));

function Row(props: { row: BenchRow; self: boolean }) {
  return (
    <tr classList={{ "bench-self": props.self }} title={rowTitle(props.row)}>
      <td class="bench-machine">
        {props.self ? <span class="bench-tag">{t("measured.thisRun")}</span> : null}
        <span class="bench-name">{shortMachine(props.row.machine)}</span>
        <span class="bench-engine">{engineText(props.row)}</span>
      </td>
      <td class="num bench-ts">{timestepsText(props.row.timesteps)}</td>
      <td class="num">{time(props.row.solver_s)}</td>
      <td class="num">{mcells(props.row.mcells_s)}</td>
    </tr>
  );
}

export default function MeasuredTimes(props: { bundle: Bundle }) {
  load();
  const view = createMemo(() => benchView(file(), props.bundle));
  return (
    <Show when={view()}>
      {(v) => (
        <div class="bench">
          <table class="table table-bench">
            <caption>{t("measured.caption")}</caption>
            <thead>
              <tr>
                <th>{t("measured.machine")}<span class="th-unit">{t("measured.engine")} · {t("measured.threads")}</span></th>
                <th class="num">{t("measured.timesteps")}</th>
                <th class="num" title={t("measured.solverTitle")}>{t("measured.solver")}<span class="th-unit">s</span></th>
                <th class="num">{t("measured.speed")}<span class="th-unit">MCells/s</span></th>
              </tr>
            </thead>
            <tbody>
              <For each={v().rows}>{(r) => <Row row={r.row} self={r.self} />}</For>
              <Show when={v().thisRun}>{(r) => <Row row={r()} self />}</Show>
            </tbody>
          </table>
          <Show when={ports(v()) > 1}>
            <p class="note">{t("measured.portRunsNote", { count: ports(v()) })}</p>
          </Show>
          <Show when={v().paramNote}><p class="note">{v().paramNote}</p></Show>
          <Show when={v().meshNote}><p class="note">{v().meshNote}</p></Show>
        </div>
      )}
    </Show>
  );
}
