// The Summary result tab: the Examples dock's Run card for a design's run. One run
// shows its verdict, the headline numbers, the matched bands, the far-field values, the efficiency and
// what the solver did; several runs (the Compare picker, Ctrl/⌘-click in the tree) show one row per
// run with the parameters that differ between them (resultTabs.ts differingParams, the same columns as
// the Runs table). The numbers come from runSummary.ts; Copy data and CSV in the toolbar write the
// same table (resultData.ts, English headers and decimal points). The comparison shows each run's
// difference from the reference run under the value or, in the "Δ vs A" view, first (the reference is
// chosen above the table; by default the oldest selected run, which is A when it is selected); the view
// and the reference are summaryMode.ts, and the Δ view adds Δ columns to Copy data and CSV.
import { createMemo, For, type JSX, Show } from "solid-js";
import { CircleCheck } from "lucide-solid";
import { bandTexts } from "../lib/bands";
import { columnDecimals, compact, ghzText, num, seconds } from "../lib/format";
import { efficiencyWarningUi } from "../lib/runText";
import { farfieldSummary } from "../lib/farfieldQuantity";
import { designResult } from "../runner/designRun";
import type { Bundle } from "../types";
import { radioGroupKeys } from "../lib/a11y";
import { fmt, t } from "../i18n";
import { differingParams } from "./resultTabs";
import { RunQualityBadge } from "./RunQualityView";
import { bundleQuality, bundleRunMetrics, comparedRuns, runLabel, runShortLabel } from "./runResults";
import { deltaLabel, metricDeltas, referenceIndex, type DeltaKey, type MetricDelta, type RunMetrics } from "./runSummary";
import { chooseSummaryReference, summaryMode, summaryReference, writeSummaryMode, type SummaryMode } from "./summaryMode";
import "../styles/run-summary.css";

// a minus sign, not a hyphen, on negative dB values
const signed = (v: number | null | undefined, digits: number) => num(v, digits).replace(/^-/, "−");
// a frequency as every result view prints it: GHz with four significant digits (2.404, 11.16)
const ghz = (hz: number | null | undefined) => (hz == null ? "—" : ghzText(hz / 1e9));
const mhz = (hz: number | null | undefined) => (hz == null ? "—" : num(hz / 1e6, 0));
const percent = (v: number | null | undefined, digits = 1) => (v == null ? "—" : num(v * 100, digits));

/** One headline number: a label over a large value with its unit and a caption. */
function Tile(props: { label: string; value: string; unit?: string; caption?: string; title?: string; warn?: boolean }): JSX.Element {
  return (
    <div class="rs-tile" title={props.title}>
      <dt>{props.label}</dt>
      <dd classList={{ "cell-warn": props.warn }}><span class="rs-value">{props.value}</span>{props.unit ? <span class="rs-unit"> {props.unit}</span> : null}</dd>
      <Show when={props.caption}><dd class="rs-caption">{props.caption}</dd></Show>
    </div>
  );
}

/** The card of one run. */
function RunCard(props: { b: Bundle }) {
  const m = createMemo(() => bundleRunMetrics(props.b));
  const run = () => props.b.run;
  const farfields = createMemo(() => (props.b.results?.farfield ?? []).map((ff) => ({ ff, s: farfieldSummary(props.b, ff) })));
  const ports = () => new Set(farfields().map((x) => x.s.port)).size > 1;
  return (
    <Show when={m()} fallback={<div class="panel-empty">{t("summary.noResults")}</div>}>{(metrics) => (
      <div class="rs-card">
        <Show when={metrics().quality?.verdict === "converged" && run()}>{(r) => (
          <p class="status-block status-good">
            <CircleCheck size={14} aria-hidden="true" />
            <span>{t("summary.converged", { db: fmt.num(props.b.solver.end_criteria_db, 1).replace(/^-/, "\u2212"), steps: r().timesteps != null ? fmt.int(r().timesteps!) : "?" })}</span>
          </p>
        )}</Show>
        <dl class="rs-tiles" aria-label={t("summary.headline")}>
          <Show when={metrics().noResonance} fallback={<Tile label={t("summary.f0")} value={ghz(metrics().f0)} unit="GHz" title={t("summary.f0.title")} />}>
            <Tile label={t("summary.f0")} value="—" caption={t("summary.noResonance")} title={t("summary.noResonance.title", { f: ghz(metrics().f0) })} warn />
          </Show>
          <Tile label="|S11| min" value={signed(metrics().s11MinDb, 1)} unit="dB" />
          <Tile label={t("summary.bandwidth")} value={mhz(metrics().bwHz)} unit={metrics().bwHz != null ? "MHz" : undefined}
            caption={metrics().bwHz != null ? `${percent(metrics().fractionalBw)} %${metrics().bwAtEdge ? ` · ${t("results.sparams.atEdge")}` : ""}` : t("summary.noBandShort")} title={t("summary.bandwidth.title")} />
          <Show when={metrics().farfield}>{(ff) => (
            <>
              <Tile label="Dmax" value={num(ff().dmaxDbi, 2)} unit="dBi" caption={`${ghz(ff().f)} GHz`} />
              <Tile label={t("farfield.quantity.realized")} value={num(ff().realizedDbi, 2)} unit={ff().realizedDbi != null ? "dBi" : undefined} title={t("summary.realized.title")} />
            </>
          )}</Show>
          <Show when={metrics().totalEff !== null}>
            <Tile label={t("farfield.total")} value={percent(metrics().totalEff)} unit="%" title={t("summary.totalEff.title")} warn={(metrics().totalEff ?? 0) > 1} />
          </Show>
        </dl>
        <Show when={!metrics().farfield}><p class="note">{t("summary.noFarfield")}</p></Show>

        <h3 class="rs-h">{t("spec.bandsCaption")}</h3>
        <Show when={metrics().bands.length} fallback={<p class="note">{t("spec.noBand")}</p>}>
          <table class="table rs-table">
            <thead><tr>
              <th scope="col">#</th>
              <th scope="col" class="num" title={t("spec.centre.title")}>{t("spec.centre")}<span class="th-unit">GHz</span></th>
              <th scope="col" class="num" title={t("spec.bestMatch.title")}>{t("spec.bestMatch")}<span class="th-unit">GHz</span></th>
              <th scope="col" class="num">|S11| min<span class="th-unit">dB</span></th>
              <th scope="col" class="num">{t("summary.bandwidth")}<span class="th-unit">MHz</span></th>
              <th scope="col" class="num">{t("spec.bw")}<span class="th-unit">%</span></th>
              <th scope="col" class="num">{t("summary.range")}<span class="th-unit">GHz</span></th>
            </tr></thead>
            <tbody><For each={metrics().bands}>{(band, i) => {
              const c = bandTexts(band, (hz) => ghzText(hz / 1e9), fmt.fixed);
              return (
                <tr title={c.open ? t("spec.bandOpen") : undefined}>
                  <td>{i() + 1}</td>
                  <td class="num">{c.centre}</td>
                  <td class="num">{c.best}</td>
                  <td class="num">{signed(band.s11_min_db, 1)}</td>
                  <td class="num">{c.bwMhz}</td>
                  <td class="num">{c.percent}</td>
                  <td class="num rs-range">{c.range}</td>
                </tr>
              );
            }}</For></tbody>
          </table>
          <Show when={metrics().bands.some((b) => b.edge_lo || b.edge_hi)}><p class="note">{t("spec.bandOpenNote")}</p></Show>
        </Show>

        <Show when={farfields().length}>
          <h3 class="rs-h">{t("tree.result.farfields")}</h3>
          <table class="table rs-table">
            <thead><tr>
              <Show when={ports()}><th scope="col">{t("spec.port")}</th></Show>
              <th scope="col" class="num">f<span class="th-unit">GHz</span></th>
              <th scope="col" class="num">Dmax<span class="th-unit">dBi</span></th>
              <th scope="col" class="num">{t("farfield.quantity.gain")}<span class="th-unit">dBi</span></th>
              <th scope="col" class="num">{t("farfield.quantity.realized")}<span class="th-unit">dBi</span></th>
              <th scope="col" class="num">{t("farfield.radEff")}<span class="th-unit">%</span></th>
              <th scope="col" class="num">{t("farfield.total")}<span class="th-unit">%</span></th>
            </tr></thead>
            <tbody><For each={farfields()}>{({ ff, s }) => (
              <tr>
                <Show when={ports()}><td class="mono">{s.port != null ? `P${s.port}` : "—"}</td></Show>
                <td class="num">{ghz(ff.f)}</td>
                <td class="num">{num(ff.dmax_dbi, 2)}</td>
                <td class="num">{num(s.gainDbi, 2)}</td>
                <td class="num">{num(s.realizedDbi, 2)}</td>
                <td class="num" classList={{ "cell-warn": !!efficiencyWarningUi(ff) }} title={efficiencyWarningUi(ff) ?? undefined}>{percent(s.radEff)}</td>
                <td class="num">{percent(s.totalEff)}</td>
              </tr>
            )}</For></tbody>
          </table>
        </Show>

        <Show when={run()}>{(r) => (
          <>
            <h3 class="rs-h">{t("spec.run")}</h3>
            <dl class="kv rs-kv">
              <dt>{t("spec.timesteps")}</dt><dd class="mono">{r().timesteps != null ? fmt.int(r().timesteps!) : "—"}</dd>
              <dt>{t("spec.solverTime")}</dt><dd class="mono">{seconds(r().solver_time_s)}</dd>
              <dt>{t("measured.engine")}</dt><dd class="mono">{r().engine === "gpu" ? "GPU" : r().engine === "cpu" ? "CPU" : props.b.solver.engine}</dd>
              <dt>{t("results.mesh.cells")}</dt><dd class="mono">{compact(props.b.mesh.total_cells)}</dd>
            </dl>
          </>
        )}</Show>
      </div>
    )}</Show>
  );
}

/** One metric cell of the comparison: the value with the difference from the reference run under it
 * ("Values") or the difference first with the value under it ("Δ vs A"). The first run and a metric
 * either run lacks have the value alone. The difference is coloured only when it is clearly better
 * or worse; the word is there for a screen reader too. */
function MetricCell(props: { value: string; k: DeltaKey; delta: MetricDelta | null | undefined; mode: SummaryMode; title?: string }) {
  const label = () => (props.delta ? deltaLabel(props.k, props.delta, fmt.fixed, t("summary.delta.pp")) : "");
  const tip = () => (props.delta ? t(`summary.delta.${props.delta.tone === "neutral" ? "diff" : props.delta.tone}`) : undefined);
  return (
    <td class="num rs-metric" title={props.title}>
      <Show when={props.delta} fallback={props.value}>{(d) => (
        <>
          <span class="rs-cell-1" classList={{ "rs-delta": props.mode === "delta", [`rs-${d().tone}`]: props.mode === "delta" }} title={props.mode === "delta" ? tip() : undefined}>
            {props.mode === "delta" ? label() : props.value}
          </span>
          <span class="rs-cell-2" classList={{ "rs-delta": props.mode === "values", [`rs-${d().tone}`]: props.mode === "values" }} title={props.mode === "values" ? tip() : undefined}>
            {props.mode === "values" ? label() : props.value}
          </span>
          <Show when={d().tone !== "neutral"}><span class="visually-hidden"> ({tip()})</span></Show>
        </>
      )}</Show>
    </td>
  );
}

/** Several runs: one row each, oldest letter first as the plots list them, with the parameters that differ. */
function RunsCompare(props: { runs: { file: string; bundle: Bundle }[] }) {
  const rows = createMemo(() => props.runs.map((r) => ({ ...r, letter: runShortLabel(r.file), name: runLabel(r.file), m: bundleRunMetrics(r.bundle) })));
  const columns = createMemo(() => differingParams(rows().map((r) => r.bundle.model)));
  const any = (pick: (m: RunMetrics) => unknown) => rows().some((r) => r.m && pick(r.m) != null);
  // the reference run: the chosen one while it is compared, else the oldest (not the first row, which
  // is the newest run in focus); the differences of every other run from it, computed once per row
  const refIdx = createMemo(() => referenceIndex(rows(), summaryReference()));
  const deltas = createMemo(() => rows().map((r, i) => (i === refIdx() ? null : metricDeltas(rows()[refIdx()].m, r.m))));
  // a parameter column with one number of decimals (the most precise value's, at most 4), as in the Runs table
  const paramValue = (b: Bundle, key: string) => b.model.params.find((p) => p.key === key)?.value;
  const paramDigits = createMemo(() => new Map(columns().map((p) => [p.key, columnDecimals(rows().map((r) => paramValue(r.bundle, p.key)))])));
  const paramText = (b: Bundle, key: string) => {
    const v = paramValue(b, key);
    return v === undefined ? "—" : typeof v === "number" ? fmt.fixed(v, paramDigits().get(key) ?? 0) : String(v);
  };
  const ref = () => rows()[refIdx()].letter;
  const refFile = () => rows()[refIdx()].file;
  const modes: SummaryMode[] = ["values", "delta"];
  return (
    <div class="rs-card">
      <p class="note">{columns().length ? t("summary.compare.differ") : t("summary.compare.same")}</p>
      <div class="rs-modebar">
        <div class="seg seg-sm" role="radiogroup" aria-label={t("summary.mode.label")} onKeyDown={radioGroupKeys}>
          <For each={modes}>{(m) => (
            <button class="seg-btn" type="button" role="radio" aria-checked={summaryMode() === m} tabindex={summaryMode() === m ? 0 : -1}
              classList={{ active: summaryMode() === m }} onClick={() => writeSummaryMode(m)}>
              {m === "values" ? t("summary.mode.values") : t("summary.mode.delta", { run: ref() })}
            </button>
          )}</For>
        </div>
        <label class="rs-ref">
          <span class="note">{t("summary.reference.label")}</span>
          {/* each option says whether it is the reference: a value on the select is applied before its
              options exist, and the browser would show the first one */}
          <select class="rp-select dz-input" onChange={(e) => chooseSummaryReference(e.currentTarget.value)}>
            <For each={rows()}>{(row) => <option value={row.file} selected={row.file === refFile()}>{t("summary.reference.option", { run: row.letter, name: row.name })}</option>}</For>
          </select>
        </label>
        <span class="note">{t("summary.mode.hint", { run: ref() })}</span>
      </div>
      <div class="rs-scroll" tabIndex={0} role="group" aria-label={t("summary.compare.label")}>
        <table class="table rs-table rs-compare">
          <caption class="visually-hidden">{t("summary.compare.caption")}</caption>
          <thead><tr>
            <th scope="col">{t("runDock.runs.col.run")}</th>
            <th scope="col">{t("runDock.runs.col.name")}</th>
            <For each={columns()}>{(p) => <th scope="col" class="num">{p.key}{p.unit ? <span class="th-unit">{p.unit}</span> : ""}</th>}</For>
            <th scope="col" class="num" title={t("summary.f0.title")}>{t("summary.f0")}<span class="th-unit">GHz</span></th>
            <th scope="col" class="num">|S11| min<span class="th-unit">dB</span></th>
            <th scope="col" class="num" title={t("summary.bandwidth.title")}>{t("spec.bw")}<span class="th-unit">MHz</span></th>
            <Show when={any((m) => m.farfield)}><th scope="col" class="num">Dmax<span class="th-unit">dBi</span></th></Show>
            <Show when={any((m) => m.farfield?.realizedDbi)}><th scope="col" class="num" title={t("summary.realized.title")}>{t("farfield.quantity.realized")}<span class="th-unit">dBi</span></th></Show>
            <Show when={any((m) => m.totalEff)}><th scope="col" class="num" title={t("summary.totalEff.title")} aria-label={t("farfield.total")}>{"\u03b7"} {t("summary.total")}<span class="th-unit">%</span></th></Show>
          </tr></thead>
          <tbody><For each={rows()}>{(row, i) => (
            <tr>
              <th scope="row" class="rs-letter">{row.letter}</th>
              <td class="rs-name" title={row.name}>
                {/* the badge is an icon (its words in its title and for screen readers): the name keeps the width */}
                <div class="rs-name-in">
                  <span class="rs-name-text">{row.name}</span>
                  <RunQualityBadge compact q={bundleQuality(row.bundle)} />
                </div>
              </td>
              <For each={columns()}>{(p) => <td class="num">{paramText(row.bundle, p.key)}</td>}</For>
              <MetricCell k="f0" value={row.m?.noResonance ? t("summary.noResonanceShort") : ghz(row.m?.f0)} title={row.m?.noResonance ? t("summary.noResonance") : undefined} delta={deltas()[i()]?.f0} mode={summaryMode()} />
              <MetricCell k="s11" value={signed(row.m?.s11MinDb, 1)} delta={deltas()[i()]?.s11} mode={summaryMode()} />
              <MetricCell k="bw" value={mhz(row.m?.bwHz)} delta={deltas()[i()]?.bw} mode={summaryMode()} />
              <Show when={any((m) => m.farfield)}><MetricCell k="dmax" value={num(row.m?.farfield?.dmaxDbi, 2)} delta={deltas()[i()]?.dmax} mode={summaryMode()} /></Show>
              <Show when={any((m) => m.farfield?.realizedDbi)}><MetricCell k="realized" value={num(row.m?.farfield?.realizedDbi, 2)} delta={deltas()[i()]?.realized} mode={summaryMode()} /></Show>
              <Show when={any((m) => m.totalEff)}><MetricCell k="eff" value={percent(row.m?.totalEff)} delta={deltas()[i()]?.eff} mode={summaryMode()} /></Show>
            </tr>
          )}</For></tbody>
        </table>
      </div>
    </div>
  );
}

/** The Summary tab of the shown run, or of the compared runs. */
export function ResultSummary(props: { b: Bundle }) {
  const runs = createMemo(() => {
    const current = designResult();
    const others = comparedRuns();
    return others.length && current ? [{ file: current.file, bundle: props.b }, ...others] : [];
  });
  return (
    <div class="rs">
      <Show when={runs().length >= 2} fallback={<RunCard b={props.b} />}><RunsCompare runs={runs()} /></Show>
    </div>
  );
}
