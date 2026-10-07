// The far-field card of the 3D view (Viewport.tsx, top right) while the 3D pattern is shown: the
// quantity drawn (Directivity, Gain, Realized gain, RHCP/LHCP), its colour scale, the far-field
// frequency (and driven port) chips, and Dmax, gain, realized gain, radiation and total efficiency and
// the main-lobe direction, like the side panel of the designer's Pattern tab. Collapsed it keeps the
// colour scale (colour encodes the value) and hides the rest. Shared by the Examples viewer and the
// designer: the chips call `onSelect` with the entry index.
import { createMemo, createSignal, For, Show } from "solid-js";
import { ChevronDown, ChevronUp, TriangleAlert } from "lucide-solid";
import { radioGroupKeys } from "../lib/a11y";
import { ghzText, num, withUnit } from "../lib/format";
import { efficiencyIssue, efficiencyWarningUi } from "../lib/runText";
import {
  effectiveQuantity, farfieldSummary, OMNI_PHI_DB, PATTERN_QUANTITIES, QUANTITY_LABEL, quantityAvailability, quantityMax, toDb, type PatternQuantity,
} from "../lib/farfieldQuantity";
import { patternQuantity, setPatternQuantity } from "../lib/patternQuantityStore";
import { PATTERN_RANGE_DB } from "../scene/patternRange";
import type { Bundle, FarField } from "../types";
import { t } from "../i18n";
import "../styles/farfield-card.css";

const [collapsed, setCollapsed] = createSignal(false);

const pct = (v: number | null) => (v === null ? "—" : t("format.percent", { value: num(v * 100, 1) }));
const minus = (s: string) => s.replace(/^-/, "−");
/** θ, φ of the maximum; at a pole φ names no direction, so the axis is given instead, and neither does
 * it for a pattern omnidirectional in φ (it varies by less than OMNI_PHI_DB on the peak's cone: a dipole
 * peaks at θ 90° at any φ, and a φ value would only be a grid artefact). */
export const lobeText = (p: { theta: number; phi: number; phiRippleDb?: number | null }) =>
  p.theta < 0.5 ? "θ 0° (+z)" : p.theta > 179.5 ? "θ 180° (−z)"
    : p.phiRippleDb != null && p.phiRippleDb < OMNI_PHI_DB ? `θ ${num(p.theta, 0)}° · ${t("farfield.omniPhi")}`
      : `θ ${num(p.theta, 0)}° · φ ${num(p.phi, 0)}°`;
/** The total efficiency as a percentage and in dB, each with its unit kept on its line ("75.5 % · −1.22 dB"). */
export const totalEffText = (eff: number) => `${t("format.percent", { value: num(eff * 100, 1) })} · ${withUnit(minus(num(toDb(eff), 2)), "dB")}`;
/** A value with its unit kept together ("2.15 dBi"), or "—". */
const dbi = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : withUnit(num(v, 2), "dBi"));

/** The quantity picker (a native select: keyboard and screen readers for free); options a far field
 * cannot show are disabled with the reason as their tooltip. */
export function PatternQuantitySelect(props: { bundle: Bundle; ff: FarField; id?: string; class?: string; directivityOnly?: string }) {
  const options = () => PATTERN_QUANTITIES.filter((q) => (q !== "rhcp" && q !== "lhcp") || !!props.ff.cp);
  const avail = (q: PatternQuantity) => (props.directivityOnly && q !== "directivity" ? { ok: false, reason: noteText(props.directivityOnly) } : quantityAvailability(props.bundle, props.ff, q));
  const shown = () => (props.directivityOnly ? "directivity" : effectiveQuantity(props.bundle, props.ff, patternQuantity()));
  return (
    <select id={props.id} class={props.class ?? "rp-select ff-quantity"} aria-label={t("farfield.quantityAria")} value={shown()}
      title={noteText(avail(shown()).reason)}
      onChange={(e) => setPatternQuantity(e.currentTarget.value as PatternQuantity)}>
      <For each={options()}>{(q) => {
        const a = () => avail(q);
        return <option value={q} disabled={!a().ok} title={a().reason}>{QUANTITY_LABEL[q]}{a().ok ? "" : ` (${t("farfield.unavailable")})`}</option>;
      }}</For>
    </select>
  );
}

/** Why the chosen quantity is not drawn (it falls back to directivity), or null. */
export function quantityFallbackNote(b: Bundle, ff: FarField, q: PatternQuantity): string | null {
  const a = quantityAvailability(b, ff, q);
  return a.ok ? null : t("farfield.fallbackNote", { quantity: QUANTITY_LABEL[q], reason: a.reason });
}

/** Shown for a synthesized array pattern (lib/arrayStore.ts farfieldOverride: every port fed). The
 * English text; the card and the quantity picker show it in the UI language (arrayPatternNote). */
export const ARRAY_PATTERN_NOTE = "The array pattern (all ports fed with the current feed) has directivity only: gain needs a radiation efficiency of the combination.";
export const arrayPatternNote = () => t("farfield.arrayPatternNote");
/** A note passed in as `directivityOnly`: the array note in the UI language, any other as it is. */
const noteText = (s: string) => (s === ARRAY_PATTERN_NOTE ? arrayPatternNote() : s);

export default function FarfieldCard(props: { bundle: Bundle; ff: FarField; entries: FarField[]; active: number; onSelect: (i: number) => void; arrayPattern?: boolean }) {
  const q = () => (props.arrayPattern ? "directivity" : effectiveQuantity(props.bundle, props.ff, patternQuantity()));
  const top = () => (props.arrayPattern ? props.ff.dmax_dbi : quantityMax(props.bundle, props.ff, patternQuantity()));
  const s = createMemo(() => farfieldSummary(props.bundle, props.ff));
  const multiPort = () => props.entries.some((f) => f.port != null) && new Set(props.entries.map((f) => f.port)).size > 1;
  const samePorts = (f: FarField, i: number) => props.entries.some((g, j) => j !== i && g.f === f.f);
  const warn = () => efficiencyIssue(props.ff);
  const note = () => efficiencyWarningUi(props.ff);
  const fallback = () => (props.arrayPattern ? arrayPatternNote() : quantityFallbackNote(props.bundle, props.ff, patternQuantity()));
  const bodyId = "ff-card-body";
  // round tick values (0, -10, -20) placed by value on the ramp, whose top is `top()` and bottom
  // PATTERN_RANGE_DB below it; a tick at the top value (4.1) is Dmax's row in the list below
  const roundTicks = () => {
    const hi = top(), lo = hi - PATTERN_RANGE_DB;
    const out: { v: number; f: number }[] = [];
    for (let v = Math.ceil(lo / 10) * 10; v <= hi + 1e-9; v += 10) out.push({ v, f: (v - lo) / PATTERN_RANGE_DB });
    return out;
  };
  return (
    <div class="colorbar ff-card" role="group" aria-label={t("farfield.cardAria", { quantity: QUANTITY_LABEL[q()] })}>
      <div class="ff-card-head">
        <div class="colorbar-title">{QUANTITY_LABEL[q()]} · {ghzText(props.ff.f / 1e9)} GHz<Show when={props.arrayPattern} fallback={<Show when={multiPort() && s().port != null}> · P{s().port}</Show>}> · {t("farfield.arrayTag")}</Show></div>
        <button type="button" class="icon-btn icon-btn-sm" aria-expanded={!collapsed()} aria-controls={bodyId}
          aria-label={collapsed() ? t("farfield.showValues") : t("farfield.hideValues")}
          title={collapsed() ? t("farfield.showValues") : t("farfield.hideValuesTitle")}
          onClick={() => setCollapsed(!collapsed())}>
          <Show when={collapsed()} fallback={<ChevronUp size={14} aria-hidden="true" />}><ChevronDown size={14} aria-hidden="true" /></Show>
        </button>
      </div>
      <Show when={!collapsed()}>
        <div class="ff-card-controls">
          <PatternQuantitySelect bundle={props.bundle} ff={props.ff} directivityOnly={props.arrayPattern ? ARRAY_PATTERN_NOTE : undefined} />
          <Show when={props.entries.length > 1}>
            <div class="freq-chips" role="radiogroup" aria-label={t("farfield.frequency")} onKeyDown={radioGroupKeys}>
              <For each={props.entries}>{(f, i) => (
                <button type="button" role="radio" class="chip-btn" aria-checked={props.active === i()} classList={{ active: props.active === i() }}
                  tabindex={props.active === i() ? 0 : -1}
                  title={multiPort() && f.port ? t("farfield.portDriven", { port: f.port }) : undefined} onClick={() => props.onSelect(i())}>
                  {ghzText(f.f / 1e9)}<Show when={f.port && samePorts(f, i())}> · P{f.port}</Show>
                </button>
              )}</For>
            </div>
          </Show>
          <Show when={fallback()}><p class="ff-card-note" role="note">{fallback()}</p></Show>
        </div>
      </Show>
      {/* a short view folds the scale: the caption goes into the ramp's tooltip and the unit onto the top tick */}
      <div class="colorbar-body" title={`${t("farfield.scaleUnit", { range: PATTERN_RANGE_DB })}${q() === "rhcp" || q() === "lhcp" ? ` · ${t("farfield.topIsDmax")}` : ""}`}>
        <div class="colorbar-ramp" aria-hidden="true" />
        <div class="colorbar-ticks colorbar-ticks-round">
          <For each={roundTicks()}>{(k, i) => <span style={{ "--f": k.f }}>{minus(num(k.v, 0))}<Show when={i() === roundTicks().length - 1}><span class="ff-tick-unit"> dBi</span></Show></span>}</For>
        </div>
      </div>
      <div class="colorbar-unit ff-scale-unit">{t("farfield.scaleUnit", { range: PATTERN_RANGE_DB })}<Show when={q() === "rhcp" || q() === "lhcp"}> · {t("farfield.topIsDmax")}</Show></div>
      <Show when={!collapsed()}>
        <dl class="kv ff-card-kv" id={bodyId}>
          <dt>Dmax</dt><dd class="mono">{dbi(s().dmaxDbi)}</dd>
          <Show when={!props.arrayPattern} fallback={<><dt>{t("farfield.pattern")}</dt><dd>{t("farfield.arrayAllFed")}</dd></>}>
          <dt>{t("farfield.quantity.gain")}</dt><dd class="mono">{dbi(s().gainDbi)}</dd>
          <dt>{t("farfield.quantity.realized")}</dt><dd class="mono">{dbi(s().realizedDbi)}</dd>
          <dt>{t("farfield.radEff")}</dt>
          <dd class="mono" classList={{ "cell-warn": !!warn() }} title={note() ?? undefined}>
            {pct(s().radEff)}<Show when={warn()}> <TriangleAlert size={12} aria-label={t("farfield.overUnity")} /></Show>
          </dd>
          <dt title={t("farfield.mismatchTitle")}>{t("farfield.mismatch")}</dt><dd class="mono">{pct(s().mismatchEff)}</dd>
          <dt title={t("farfield.totalTitle")}>{t("farfield.total")}</dt>
          <dd class="mono" classList={{ "cell-warn": !!warn() }}>
            {s().totalEff !== null ? totalEffText(s().totalEff!) : "—"}
          </dd>
          </Show>
          <dt title={t("farfield.lobeTitle")}>{t("farfield.mainLobe")}</dt><dd class="mono">{lobeText(s().peak)}</dd>
          <Show when={!props.arrayPattern && multiPort() && s().port != null}><dt>{t("farfield.drivenPort")}</dt><dd class="mono">P{s().port}</dd></Show>
        </dl>
      </Show>
    </div>
  );
}
