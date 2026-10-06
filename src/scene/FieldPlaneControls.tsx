// The controls and the colour bar of a field-plane map, shared by the 3D view's colour-scale column
// (FieldPlaneScale.tsx) and the designer's 2D field-map tab (designer/FieldMapView.tsx): what to
// show (Magnitude, Phase, Animate), the component of a map that stores several, the dB / Linear
// scale, and the play / instant controls of the animation. The state is shared (state.ts), so the
// two views show the same thing.
import { createMemo, For, Show } from "solid-js";
import { Pause, Play } from "lucide-solid";
import { fieldPlaneMode, fieldPlanePart, fieldPlanePhase, fieldPlanePlaying, fieldPlaneScale, setFieldPlaneMode, setFieldPlanePart, setFieldPlanePhase, setFieldPlanePlaying, setFieldPlaneScale } from "../state";
import type { FieldPlaneMap } from "../types";
import { radioGroupKeys } from "../lib/a11y";
import { cssVar } from "../lib/cssvar";
import { fmt, t } from "../i18n";
import "../styles/field-map.css";
import { effectiveView, FIELD_PLANE_DB_RANGE, fieldPlaneValues, hasPhasor, legendOf, partsOf, type FieldPlaneMode, type FieldPlanePart, type FieldPlaneView, type FieldValues, type RGB } from "./fieldPlaneModel";
import { prefersReducedMotion } from "./fieldPlaneClock";

/** the Turbo field ramp of the design tokens, as sRGB bytes */
const FALLBACK_RAMP = ["#493dab", "#3789f9", "#25cdd0", "#48f789", "#96fa50", "#e5d730", "#ff9520", "#e54813", "#a01101"];
export function fieldRampRgb(): RGB[] {
  return FALLBACK_RAMP.map((fallback, i) => {
    let css = "";
    try { css = cssVar(`--al-field-${i}`); } catch { /* no styles (a script without a DOM) */ }
    const hex = /^#([0-9a-f]{6})$/i.exec(css)?.[1] ?? fallback.slice(1);
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as RGB;
  });
}

/** The view state as the model takes it; `phase` false leaves the instant of the animation out, for
 * what does not depend on it (the colour bar, the controls) and so does not redraw every frame. */
export const currentFieldPlaneView = (phase = true): FieldPlaneView => ({ mode: fieldPlaneMode(), part: fieldPlanePart(), scale: fieldPlaneScale(), phaseDeg: phase ? fieldPlanePhase() : 0 });

const componentName = (m: FieldPlaneMap, c: string) => (c === "all" ? `|${m.quantity}|` : `${m.quantity}${c}`);

/** The heading of what a view shows: "|E| (dB, 0 dB = 12.3 V/m)", "Phase of Ez", "Ez(t) (V/m)". */
export function valueLabel(m: FieldPlaneMap, fv: FieldValues, scale: "db" | "linear"): string {
  const ref = fmt.num(Number(fv.ref.toPrecision(3)), 12);
  if (fv.kind === "phase") return t("fieldPlane.label.phase", { name: componentName(m, fv.component) });
  if (fv.kind === "signed") return t("fieldPlane.label.signed", { name: componentName(m, fv.component), unit: m.unit });
  const name = fv.instant ? `|${m.quantity}(t)|` : componentName(m, fv.component);
  return scale === "db" ? t("fieldPlane.label.db", { name, ref, unit: m.unit }) : t("fieldPlane.label.linear", { name, unit: m.unit });
}

export function FieldPlaneControls(props: { map: FieldPlaneMap }) {
  const phased = () => hasPhasor(props.map);
  const view = createMemo(() => effectiveView(props.map, currentFieldPlaneView(false)));
  const parts = () => partsOf(props.map);
  const scaleApplies = () => view().mode === "magnitude" || (view().mode === "animate" && view().part === "all" && parts().length > 1);
  const modes: { id: FieldPlaneMode; label: string; title: string }[] = [
    { id: "magnitude", label: t("fieldPlane.mode.magnitude"), title: t("fieldPlane.mode.magnitudeTitle") },
    { id: "phase", label: t("fieldPlane.mode.phase"), title: t("fieldPlane.mode.phaseTitle") },
    { id: "animate", label: t("fieldPlane.mode.animate"), title: t("fieldPlane.mode.animateTitle") },
  ];
  const partLabel = (p: FieldPlanePart) => {
    if (p !== "all") return componentName(props.map, p);
    return view().mode === "phase" ? t("fieldPlane.part.strongest", { name: componentName(props.map, view().part === "all" ? "z" : view().part) }) : componentName(props.map, "all");
  };
  const reduced = prefersReducedMotion();
  return (
    <div class="fp-controls">
      <Show when={phased()} fallback={<div class="colorbar-note">{t("fieldPlane.noPhase")}</div>}>
        <div class="seg seg-sm" role="radiogroup" aria-label={t("fieldPlane.mode.aria")} onKeyDown={radioGroupKeys}>
          <For each={modes}>{(mode) => (
            <button class="seg-btn" role="radio" aria-checked={view().mode === mode.id} tabindex={view().mode === mode.id ? 0 : -1} title={mode.title}
              onClick={() => setFieldPlaneMode(mode.id)}>{mode.label}</button>
          )}</For>
        </div>
        <Show when={parts().length > 1}>
          <label class="fp-part"><span>{t("fieldPlane.part.label")}</span>
            <select class="btn btn-ghost btn-sm" onChange={(e) => setFieldPlanePart(e.currentTarget.value as FieldPlanePart)}>
              <For each={parts()}>{(p) => <option value={p} selected={(parts().includes(fieldPlanePart()) ? fieldPlanePart() : "all") === p}>{partLabel(p)}</option>}</For>
            </select>
          </label>
        </Show>
      </Show>
      <div class="seg seg-sm" role="radiogroup" aria-label={t("viewport.fieldPlane.scale")} onKeyDown={radioGroupKeys}
        title={scaleApplies() ? undefined : t("fieldPlane.scaleNotApplicable")}>
        <button class="seg-btn" role="radio" aria-checked={fieldPlaneScale() === "db"} disabled={!scaleApplies()} tabindex={fieldPlaneScale() === "db" ? 0 : -1}
          onClick={() => setFieldPlaneScale("db")} title={t("viewport.fieldPlane.dbTitle", { range: FIELD_PLANE_DB_RANGE })}>dB</button>
        <button class="seg-btn" role="radio" aria-checked={fieldPlaneScale() === "linear"} disabled={!scaleApplies()} tabindex={fieldPlaneScale() === "linear" ? 0 : -1}
          onClick={() => setFieldPlaneScale("linear")} title={t("viewport.fieldPlane.linearTitle")}>{t("viewport.fieldPlane.linear")}</button>
      </div>
      <Show when={phased() && view().mode === "animate"}>
        <div class="current-phase-controls">
          <div class="current-phase-actions">
            <button class="btn btn-ghost btn-sm" aria-pressed={fieldPlanePlaying()} disabled={reduced} title={reduced ? t("fieldPlane.reducedMotion") : undefined}
              onClick={() => setFieldPlanePlaying(!fieldPlanePlaying())}>
              {fieldPlanePlaying() ? <><Pause size={12} aria-hidden="true" /> {t("viewport.current.pause")}</> : <><Play size={12} aria-hidden="true" /> {t("viewport.current.play")}</>}
            </button>
            <span class="current-phase-value">ωt = {fieldPlanePhase()}°</span>
          </div>
          <label class="visually-hidden" for="field-plane-phase">{t("fieldPlane.phaseLabel")}</label>
          <input id="field-plane-phase" type="range" min="0" max="359" step="1" value={fieldPlanePhase()}
            aria-valuetext={t("array.degrees", { n: fieldPlanePhase() })}
            onInput={(e) => setFieldPlanePhase(Number(e.currentTarget.value))} />
        </div>
      </Show>
    </div>
  );
}

/** A vertical colour bar with its tick labels for what the view shows. */
export function FieldPlaneLegend(props: { map: FieldPlaneMap; height?: number }) {
  const ramp = createMemo(() => fieldRampRgb());
  const legend = createMemo(() => {
    const v = currentFieldPlaneView(false);
    return legendOf(fieldPlaneValues(props.map, v), v.scale, ramp());
  });
  const gradient = () => `linear-gradient(to bottom, ${legend().colors.map((c) => `rgb(${c.map(Math.round).join(",")})`).join(", ")})`;
  return (
    <div class="colorbar-body" style={props.height ? { height: `${props.height}px` } : undefined}>
      <div class="colorbar-ramp" aria-hidden="true" style={{ background: gradient() }} />
      <div class="colorbar-ticks">
        <For each={legend().ticks}>{(tick) => <span>{tick}</span>}</For>
      </div>
    </div>
  );
}
