import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { FileSpreadsheet, TriangleAlert } from "lucide-solid";
import type { Bundle } from "../types";
import { mimoAnalysis, type MimoAnalysis, type MimoValue, type MimoComplex } from "../lib/mimo";
import { diversityCsv } from "../export/diversity";
import { saveDownload } from "../lib/download";
import { downloadToast, showToast } from "../lib/toast";
import { freqText, num } from "../lib/format";
import LineChart from "../charts/LineChart";
import NumberField from "../components/NumberField";
import { t } from "../i18n";
import "../styles/diversity.css";

/** Stateless bundle boundary: pair and excitation edits are session-only and reset on
 * source replacement. Root can capture the exact table/CSV snapshot via onAnalysis. */
export default function ResultDiversity(props: { b: Bundle; onAnalysis?: (analysis: MimoAnalysis, pair: [number, number] | undefined) => void }) {
  const initial = createMemo(() => mimoAnalysis(props.b));
  const [pairKey, setPairKey] = createSignal("");
  const [inputs, setInputs] = createSignal<Record<number, [string, string]>>({});
  createEffect(() => {
    const ports = initial().ports;
    setPairKey(ports.length >= 2 ? `${ports[0]},${ports[1]}` : "");
    setInputs(Object.fromEntries(ports.map(port => [port, ["1", "0"] as [string, string]])));
  });
  const weights = createMemo(() => new Map(initial().ports.map(port => {
    const v = inputs()[port] ?? ["", ""];
    return [port, v.map(x => x.trim() === "" ? NaN : Number(x)) as unknown as MimoComplex] as const;
  })));
  const analysis = createMemo(() => mimoAnalysis(props.b, weights()));
  const pairs = createMemo(() => analysis().rows[0]?.pairs.map(p => p.ports) ?? []);
  const selectedPair = createMemo(() => pairs().find(p => p.join(",") === pairKey()));
  const rows = createMemo(() => analysis().rows.map(row => ({ ...row, pair: row.pairs.find(p => p.ports.join(",") === pairKey()) })));
  const warnings = createMemo(() => [...new Set(rows().flatMap(row => row.pair?.warnings ?? row.warnings))]);
  createEffect(() => props.onAnalysis?.(analysis(), selectedPair()));
  const shown = (v?: MimoValue) => v?.value == null ? "—" : num(v.value, 5);
  const reason = (v?: MimoValue) => v?.reason ? t(v.reason) : undefined;
  const edit = (port: number, index: 0 | 1, text: string) => setInputs(old => {
    const next: [string, string] = [...(old[port] ?? ["", ""])]; next[index] = text;
    return { ...old, [port]: next };
  });
  const exportCsv = async () => {
    try { downloadToast(await saveDownload("diversity.csv", diversityCsv(analysis(), selectedPair()), "text/csv;charset=utf-8")); }
    catch { showToast(t("mimo.exportFailed"), { tone: "error" }); }
  };
  return <section class="mimo-panel stack-lg" data-result-diversity aria-label={t("mimo.title")}>
    <p class="note">{t("mimo.scope")}</p>
    <Show when={!analysis().reason} fallback={<p class="panel-empty" role="status">{t(analysis().reason ?? "mimo.reason.matrix")}</p>}>
      <div class="cluster">
        <label class="cluster-sm"><span>{t("mimo.pair")}</span><select data-mimo-pair value={pairKey()} onChange={e => setPairKey(e.currentTarget.value)}>
          <For each={pairs()}>{pair => <option value={pair.join(",")}>{pair.map(p => `P${p}`).join(" / ")}</option>}</For>
        </select></label>
        <button type="button" class="btn-sm push" onClick={exportCsv} title={t("mimo.csv")}><FileSpreadsheet size={16} /><span>{t("mimo.csv")}</span></button>
      </div>
      <div class="mimo-chart">
        <LineChart preserveSampleGaps series={[{ id: "ecc-s", label: t("mimo.eccS"), color: "--al-series-1", x: rows().map(r => r.frequency / 1e9), y: rows().map(r => r.pair?.eccS.value ?? NaN) }]}
          points={[{ id: "ecc-field", label: t("mimo.eccField"), color: "--al-series-2", shape: "diamond", x: rows().filter(r => r.pair?.eccField.value != null).map(r => r.frequency / 1e9), y: rows().filter(r => r.pair?.eccField.value != null).map(r => r.pair!.eccField.value!),
            warn: rows().filter(r => r.pair?.eccField.value != null).map(r => r.pair!.warnings.length ? r.pair!.warnings.map(k => t(k)).join(" ") : null) }]}
          xLabel={t("chart.frequencyGHz")} yLabel={t("mimo.eccAxis")} yDomain={[0, 1]} ariaLabel={t("mimo.chart")} />
      </div>
      <p class="note">{t("mimo.sparse")}</p>
      <Show when={warnings().length}><div class="status-block status-warn cluster-sm" role="status"><TriangleAlert size={16} /><div class="stack-sm"><For each={warnings()}>{key => <p>{t(key)}</p>}</For></div></div></Show>
      <details><summary>{t("mimo.assumptions")}</summary><div class="stack-sm"><p class="note">{t("mimo.assumptionsS")}</p><p class="note">{t("mimo.assumptionsDG")}</p><p class="note">{t("mimo.assumptionsTarc")}</p><p class="note">{t("mimo.assumptionsCapacity")}</p></div></details>
      <fieldset class="mimo-excitation stack-sm"><legend>{t("mimo.excitation")}</legend><p class="note">{t("mimo.excitationNote")}</p>
        <div class="cluster"><For each={initial().ports}>{port => <div class="cluster-sm">
          <span class="mono">P{port}</span>
          <label class="cluster-sm"><span>{t("mimo.real")}</span><NumberField step="any" value={inputs()[port]?.[0] ?? ""} aria-label={t("mimo.realPort", { port })} data-mimo-real={port} onChange={e => edit(port, 0, e.currentTarget.value)} /></label>
          <label class="cluster-sm"><span>{t("mimo.imag")}</span><NumberField step="any" value={inputs()[port]?.[1] ?? ""} aria-label={t("mimo.imagPort", { port })} data-mimo-imag={port} onChange={e => edit(port, 1, e.currentTarget.value)} /></label>
        </div>}</For></div>
      </fieldset>
      <div class="mimo-table" tabindex="0" role="region" aria-label={t("mimo.table")}>
        <table class="table"><caption>{t("mimo.table")}</caption><thead><tr>
          <th scope="col">{t("farfield.frequency")}</th><th scope="col">{t("mimo.eccS")}</th><th scope="col">{t("mimo.eccField")}</th>
          <th scope="col">{t("mimo.dgS")}<span class="th-unit">dB</span></th><th scope="col">{t("mimo.dgField")}<span class="th-unit">dB</span></th>
          <th scope="col">{t("mimo.tarc")}</th><th scope="col">{t("mimo.ccl")}<span class="th-unit">bits/s/Hz</span></th>
          <For each={selectedPair() ?? []}>{port => <th scope="col">{t("mimo.meg", { port })}</th>}</For>
        </tr></thead><tbody><For each={rows()}>{row => <tr data-mimo-frequency={row.frequency}>
          <th scope="row">{freqText(row.frequency)}</th>
          <For each={[row.pair?.eccS, row.pair?.eccField, row.pair?.dgS, row.pair?.dgField, row.tarc, row.ccl]}>{v => <td class="num" title={reason(v)} aria-label={v?.value == null ? reason(v) : undefined}>{shown(v)}</td>}</For>
          <For each={selectedPair() ?? []}>{port => { const metric = () => row.meg.find(m => m.port === port)?.estimate; return <td class="num" title={reason(metric())} aria-label={metric()?.value == null ? reason(metric()) : undefined}>{shown(metric())}</td>; }}</For>
        </tr>}</For></tbody></table>
      </div>
      <Show when={rows().some(r => [r.pair?.eccS, r.pair?.eccField, r.tarc, r.ccl].some(v => v?.value == null))}>
        <details open><summary>{t("mimo.unavailable")}</summary><ul class="note"><For each={[...new Set(rows().flatMap(r => [r.pair?.eccS, r.pair?.eccField, r.tarc, r.ccl].map(v => v?.reason).filter((v): v is string => !!v)))]}>{key => <li>{t(key)}</li>}</For></ul></details>
      </Show>
    </Show>
  </section>;
}
