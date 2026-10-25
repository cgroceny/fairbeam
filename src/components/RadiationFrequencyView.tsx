import { createMemo, For, Show } from "solid-js";
import type { Bundle } from "../types";
import LineChart, { type Series, type PointSeries } from "../charts/LineChart";
import { SERIES_COLORS } from "../compare/series";
import { RADIATION_QUANTITIES, radiationBands, radiationPatternPoints, radiationUnit, sampledArIntervals } from "../lib/radiationFrequency";
import { efficiencyQuantity, radiationQuantity, setEfficiencyQuantity, type EfficiencyQuantity } from "../lib/patternQuantityStore";
import { freqText, num } from "../lib/format";
import { t } from "../i18n";

export function RadiationQuantitySelect(props: { efficiency?: boolean }) {
  return <label class="radiation-select">{t("radiation.quantity")}
    <select class="btn btn-sm" value={props.efficiency ? efficiencyQuantity() : radiationQuantity()} onChange={e => setEfficiencyQuantity(e.currentTarget.value as EfficiencyQuantity)}>
      <Show when={props.efficiency}><option value="efficiency">{t("results.tab.efficiency")}</option></Show>
      <For each={RADIATION_QUANTITIES}>{q => <option value={q}>{t(`radiation.${q}`)}</option>}</For>
    </select>
  </label>;
}

/** Shared by Designer and the standalone viewer. Each run/physical port keeps its own grid. */
export default function RadiationFrequencyView(props: { b: Bundle; runs?: { label: string; bundle: Bundle }[] | null; hideSelector?: boolean }) {
  const runs = () => props.runs?.length ? props.runs : [{ label: "", bundle: props.b }];
  const records = createMemo(() => runs().flatMap((run, k) => radiationBands(run.bundle).map((d, j) => ({ ...d, id: `${k}:${j}`, label: [run.label, d.port === null ? t("radiation.unknownPort") : `P${d.port}`].filter(Boolean).join(" · "), color: SERIES_COLORS[(k + j) % SERIES_COLORS.length] }))));
  const plot = createMemo(() => {
    const q = radiationQuantity();
    const series: Series[] = records().map(d => ({ id: d.id, label: `${d.label} · ${t("radiation.coarse")}`, color: d.color, x: d.samples.map(s => s.f / 1e9), y: d.samples.map(s => s.values[q] ?? NaN) }));
    const points: PointSeries[] = records().flatMap(d => {
      const isolated = d.samples.filter((s, i, all) => s.values[q] !== null && all[i - 1]?.values[q] == null && all[i + 1]?.values[q] == null);
      return isolated.length ? [{ id: `isolated-${d.id}`, label: `${d.label} · ${t("radiation.coarse")}`, color: d.color, shape: "circle" as const, x: isolated.map(s => s.f / 1e9), y: isolated.map(s => s.values[q]!) }] : [];
    });
    points.push(...runs().flatMap((r, k) => {
      const stored = radiationPatternPoints(r.bundle);
      return [...new Set(stored.map(s => s.port))].map((port, j) => {
        const samples = stored.filter(s => s.port === port);
        return { id: `detail-${k}:${j}`, label: [r.label, port === null ? t("radiation.unknownPort") : `P${port}`, t("radiation.detailed")].filter(Boolean).join(" · "), color: SERIES_COLORS[(k + j) % SERIES_COLORS.length], shape: "diamond" as const, x: samples.map(s => s.f / 1e9), y: samples.map(s => s.values[q] ?? NaN), warn: samples.map(() => t("radiation.detailedNote")) };
      });
    }));
    return { series, points };
  });
  const ar = () => radiationQuantity().startsWith("ar_");
  const domain = (): [number, number] => {
    if (ar()) return [0, 60];
    const vals = [...plot().series, ...plot().points].flatMap(s => s.y).filter(Number.isFinite);
    return vals.length ? [Math.floor(Math.min(...vals) / 5) * 5 - 1, Math.ceil(Math.max(...vals) / 5) * 5 + 1] : [-10, 10];
  };
  const hasData = () => [...plot().series, ...plot().points].some(s => s.y.some(Number.isFinite));
  const text = (v: number | null) => v === null ? "—" : `${ar() && v >= 60 ? "≥" : ""}${num(v, 2)}`;
  return <div class="radiation-view" data-radiation-frequency>
    <Show when={!props.hideSelector}><RadiationQuantitySelect /></Show>
    <div class="rdk-split">
      <div class="radiation-chart">
        <LineChart series={plot().series} points={plot().points} preserveSampleGaps xLabel="f (GHz)" yLabel={`${t(`radiation.${radiationQuantity()}`)} (${radiationUnit(radiationQuantity())})`} yDomain={domain()} yFormat={v => text(v)} ariaLabel={t("radiation.aria")} hlines={ar() ? [{ y: 3, label: "3 dB" }] : []} />
        <Show when={!hasData()}><p class="rdk-note" role="status">{t("radiation.noData")}</p></Show>
      </div>
      <div class="rdk-side">
        <p class="rdk-note" role="note">{t("radiation.note")}</p>
        <Show when={ar()}><p class="rdk-note">{t("radiation.arNote")}</p></Show>
        <p class="rdk-note">{t("radiation.detailedNote")}</p>
        <For each={records()}>{d => <details class="rdk-details">
          <summary>{d.label} · {t("radiation.samples", { n: d.samples.length })}</summary>
          <p class="rdk-note">θ = {d.sweep.radiation.theta.join(", ")}°; φ = {d.sweep.radiation.phi.join(", ")}°</p>
          <For each={d.sweep.qa_warnings ?? []}>{note => <p class="rdk-note">{note}</p>}</For>
          <Show when={ar()}><p class="rdk-note">{t("radiation.intervals")}</p>
            <For each={sampledArIntervals(d.samples, radiationQuantity() as "ar_peak_db" | "ar_boresight_db")} fallback={<p class="rdk-note">{t("radiation.noInterval")}</p>}>{range => <p class="rdk-note">{freqText(range.lo)} – {freqText(range.hi)} · {t("radiation.samples", { n: range.count })}<br />{t("radiation.boundaries", { left: t(`radiation.boundary.${range.left}`), right: t(`radiation.boundary.${range.right}`) })}</p>}</For>
          </Show>
          <div class="data-table-wrap"><table class="table table-data"><thead><tr><th>f</th><th>{radiationUnit(radiationQuantity())}</th><th>{t("radiation.status")}</th></tr></thead><tbody>
            <For each={d.samples}>{s => <tr><td>{freqText(s.f)}</td><td class="mono">{text(s.values[radiationQuantity()])}</td><td>{t(`radiation.status.${s.reliability}`)}</td></tr>}</For>
          </tbody></table></div>
        </details>}</For>
      </div>
    </div>
  </div>;
}
