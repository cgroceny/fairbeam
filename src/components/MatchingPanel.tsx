import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { Bundle } from "../types";
import { sweep } from "../lib/rf";
import { matchedImpedance, matchComponents, matchingSweep, reflection, synthesizeMatches, type MatchNetwork } from "../lib/matching";
import { freqText, num } from "../lib/format";
import { t } from "../i18n";
import LineChart from "../charts/LineChart";
import NumberField from "./NumberField";

/** Ephemeral what-if state belongs to this displayed result, never a project or another run. */
export function createMatching(bundle: () => Bundle) {
  const sw = createMemo(() => sweep(bundle()));
  const port = () => bundle().ports[0]?.number;
  const [enabled, setEnabled] = createSignal(false), [index, setIndex] = createSignal(0);
  const [selected, setSelected] = createSignal("");
  createEffect(on(bundle, () => { setEnabled(false); setIndex(Math.floor((sw()?.f.length ?? 1) / 2)); setSelected(""); }));
  const eligible = createMemo(() => !!matchingSweep(bundle()));
  const candidates = createMemo(() => {
    const s = sw(), i = index();
    return eligible() && s && Number.isInteger(i) && i >= 0 && i < s.f.length
      ? synthesizeMatches({ re: s.zRe[i], im: s.zIm[i] }, s.zRef, s.f[i]) : [];
  });
  const network = () => candidates().find(n => n.id === selected()) ?? candidates()[0];
  const trace = createMemo(() => {
    const s = sw(), n = network();
    if (!enabled() || !eligible() || !s || !n) return null;
    const zs = s.f.map((f, i) => matchedImpedance(n, { re: s.zRe[i], im: s.zIm[i] }, f));
    const gs = zs.map(z => z && reflection(z, s.zRef));
    return { re: gs.map(g => g?.re ?? NaN), im: gs.map(g => g?.im ?? NaN),
      db: gs.map(g => g ? 20 * Math.log10(Math.max(1e-15, Math.hypot(g.re, g.im))) : NaN),
      zRe: zs.map(z => z?.re ?? NaN), zIm: zs.map(z => z?.im ?? NaN) };
  });
  return { sw, port, eligible, enabled, setEnabled, index, setIndex, selected, setSelected, candidates, network, trace };
}

function componentText(n: MatchNetwork): string {
  if (n.topology === "quarter-wave") return `Zt ${num(n.lineZ!, 4)} Ω · 90°`;
  const parts = matchComponents(n);
  return parts.length ? parts.map(c => `${t(`matching.${c.location}`)} ${c.kind} ${num(c.value * (c.kind === "L" ? 1e9 : 1e12), 5)} ${c.kind === "L" ? "nH" : "pF"}`).join(" → ") : t("matching.bypass");
}

export default function MatchingPanel(props: { state: ReturnType<typeof createMatching> }) {
  const m = props.state;
  const label = (n: MatchNetwork) => `${t(`matching.${n.topology}`)}: ${componentText(n)}`;
  return <section class="matching-panel" aria-label={t("matching.title")}>
    <h3>{t("matching.title")}</h3>
    <p class="note">{t("matching.ideal")}</p>
    <Show when={m.eligible()} fallback={<p class="note" data-matching-unavailable>{t("matching.unavailable")}</p>}>
      <p class="mono">P{m.port()} · Zref {num(m.sw()!.zRef, 4)} Ω</p>
      <label class="matching-enable"><input type="checkbox" checked={m.enabled()} onChange={e => m.setEnabled(e.currentTarget.checked)} />{t("matching.enable")}</label>
      <Show when={m.enabled()}>
        <label class="matching-field">{t("matching.sample", { count: m.sw()!.f.length })}
          <NumberField data-matching-sample min="1" max={m.sw()!.f.length} step="1" value={Number.isFinite(m.index()) ? m.index() + 1 : ""}
            onChange={e => m.setIndex(e.currentTarget.value === "" ? NaN : Number(e.currentTarget.value) - 1)} /></label>
        <p class="mono" data-matching-frequency>{Number.isInteger(m.index()) && m.sw()!.f[m.index()] !== undefined ? freqText(m.sw()!.f[m.index()]) : "—"}</p>
        <Show when={m.network()} fallback={<p role="status" class="note">{t("matching.noSolution")}</p>}>
          <label class="matching-field">{t("matching.network")}
            <select value={m.network()?.id} onChange={e => m.setSelected(e.currentTarget.value)}>
              <For each={m.candidates()}>{n => <option value={n.id}>{label(n)}</option>}</For>
            </select></label>
          <p class="note" data-matching-components>{componentText(m.network()!)}</p>
          <p class="note">{t("matching.order")}</p>
          <Show when={m.network()?.topology === "quarter-wave"}><p class="note">{t("matching.lineNote")}</p></Show>
          <Show when={m.trace()}>{trace => <div class="matching-chart">
            <LineChart ariaLabel={t("matching.overlay")} xLabel={t("chart.frequencyGHz")} yLabel="|S11| (dB)"
              series={[
                { id: "original", label: `${t("matching.original")} [P${m.port()}]`, color: "--al-series-1", x: m.sw()!.f.map(f => f / 1e9), y: m.sw()!.s11Db },
                { id: "matched", label: `${t("matching.matched")} [P${m.port()}]`, color: "--al-series-2", dash: "6 4", x: m.sw()!.f.map(f => f / 1e9), y: trace().db },
              ]} />
          </div>}</Show>
          <p class="note">{t("matching.planeNote")}</p>
        </Show>
      </Show>
    </Show>
  </section>;
}
