// The Field map tab: an E/H field map on a cut plane (bundle field_planes) as a 2D heat map with
// axes in mm, the colour bar and its dB / Linear scale, a hover readout of the value, and the
// structure's outline projected onto the plane. With the map's phasor it also shows the phase and
// animates the instantaneous field over one period (FieldPlaneControls.tsx, shared with the 3D
// view). Copy data and CSV of the tab are the toolbar's (ResultViews.tsx).
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Globe } from "lucide-solid";
import { ticks, tickLabel } from "../charts/scale";
import { useSize } from "../charts/useSize";
import { designResult } from "../runner/designRun";
import { fieldPlaneScale, setFieldPlanePlaying } from "../state";
import { currentFieldPlaneView, FieldPlaneControls, FieldPlaneLegend, fieldRampRgb, valueLabel } from "../scene/FieldPlaneControls";
import { setFieldMapTabOpen } from "../scene/fieldPlaneClock";
import { fieldPlaneRgba, fieldPlaneValues, planeOutline, readoutAt, sampleIndex, samplePosition, type Readout } from "../scene/fieldPlaneModel";
import type { Bundle, FieldPlaneMap } from "../types";
import { fmt, t } from "../i18n";
import { fieldPlaneLabel } from "./navModel";
import { focusResult, resultFocus } from "./resultFocus";

const AXES = ["x", "y", "z"];
const MARGIN = { l: 56, r: 16, t: 12, b: 42 };
const minus = (s: string) => s.replace(/^-/, "−");
/** three significant digits in the UI language */
const sig = (v: number) => minus(fmt.num(Number(v.toPrecision(3)), 12));

/** an axis tick in the UI language (decimal comma in Turkish) */
const axisLabel = (v: number, step: number) => { const s = tickLabel(v, step); return minus(fmt.fixed(Number(s), s.split(".")[1]?.length ?? 0)); };

const [showOutline, setShowOutline] = createSignal(true);

/** The tab body: the run's field-plane map chosen by the focus (else the first). */
export default function FieldMapView(props: { b: Bundle }) {
  const maps = () => props.b.field_planes ?? [];
  const index = () => Math.min(Math.max(0, resultFocus()?.map ?? 0), maps().length - 1);
  return (
    <Show when={maps()[index()]} fallback={<div class="panel-empty">{t("fieldMap.none")}</div>}>
      {(map) => <FieldMapPlane b={props.b} map={map()} index={index()} />}
    </Show>
  );
}

function FieldMapPlane(props: { b: Bundle; map: FieldPlaneMap; index: number }) {
  let host!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const size = useSize(() => host);
  const [probe, setProbe] = createSignal<{ i: number; j: number } | null>(null);
  const off = document.createElement("canvas");
  let buffer: Uint8ClampedArray | undefined;

  onMount(() => setFieldMapTabOpen(true));
  onCleanup(() => { setFieldMapTabOpen(false); setFieldPlanePlaying(false); });

  const ramp = createMemo(fieldRampRgb);
  const values = createMemo(() => fieldPlaneValues(props.map, currentFieldPlaneView()));
  const outline = createMemo(() => planeOutline(props.b.parts, props.map));

  // the map's extent (half a sample beyond the outer samples) fitted to the room, one scale on both axes
  const geom = createMemo(() => {
    const m = props.map, { w, h } = size();
    const hu = (m.u_range[1] - m.u_range[0]) / Math.max(1, m.nu - 1) / 2, hv = (m.v_range[1] - m.v_range[0]) / Math.max(1, m.nv - 1) / 2;
    const u0 = m.u_range[0] - hu, u1 = m.u_range[1] + hu, v0 = m.v_range[0] - hv, v1 = m.v_range[1] + hv;
    const availW = Math.max(0, w - MARGIN.l - MARGIN.r), availH = Math.max(0, h - MARGIN.t - MARGIN.b);
    const s = Math.min(availW / Math.max(1e-9, u1 - u0), availH / Math.max(1e-9, v1 - v0));
    const pw = Math.max(0, (u1 - u0) * s), ph = Math.max(0, (v1 - v0) * s);
    return { u0, u1, v0, v1, s, pw, ph, ox: MARGIN.l + (availW - pw) / 2, oy: MARGIN.t + (availH - ph) / 2 };
  });
  const px = (u: number) => geom().ox + (u - geom().u0) * geom().s;
  const py = (v: number) => geom().oy + (geom().v1 - v) * geom().s;

  createEffect(() => {
    const g = geom(), v = values(), m = props.map, scale = fieldPlaneScale();
    if (!canvas || g.pw < 2 || g.ph < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(g.pw * dpr), H = Math.round(g.ph * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    buffer = fieldPlaneRgba(m, v, scale, ramp(), true, buffer);
    if (off.width !== m.nu || off.height !== m.nv) { off.width = m.nu; off.height = m.nv; }
    off.getContext("2d")?.putImageData(new ImageData(buffer as Uint8ClampedArray<ArrayBuffer>, m.nu, m.nv), 0, 0);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(off, 0, 0, m.nu, m.nv, 0, 0, W, H);
  });

  const xTicks = () => ticks(props.map.u_range[0], props.map.u_range[1], Math.max(2, Math.round(geom().pw / 90)));
  const yTicks = () => ticks(props.map.v_range[0], props.map.v_range[1], Math.max(2, Math.round(geom().ph / 60)));
  const tickStep = (list: number[]) => (list.length > 1 ? list[1] - list[0] : 1);
  const path = (points: [number, number][]) => `M${points.map(([u, v]) => `${px(u).toFixed(1)},${py(v).toFixed(1)}`).join("L")}Z`;
  const metalPath = () => outline().filter((o) => o.metal).map((o) => path(o.points)).join("");
  const diePath = () => outline().filter((o) => !o.metal).map((o) => path(o.points)).join("");

  const onMove = (e: PointerEvent & { currentTarget: SVGRectElement }) => {
    const r = e.currentTarget.getBoundingClientRect(), g = geom();
    setProbe(sampleIndex(props.map, g.u0 + (e.clientX - r.left) / g.s, g.v1 - (e.clientY - r.top) / g.s));
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1, m = props.map;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (e.key === "Escape") { setProbe(null); return; }
    if (!d[e.key]) return;
    e.preventDefault();
    const p = probe() ?? { i: Math.floor(m.nu / 2), j: Math.floor(m.nv / 2) };
    setProbe({ i: Math.min(m.nu - 1, Math.max(0, p.i + d[e.key][0])), j: Math.min(m.nv - 1, Math.max(0, p.j + d[e.key][1])) });
  };
  const read = createMemo<Readout | null>(() => {
    const p = probe();
    return p ? readoutAt(props.map, values(), p.i, p.j) : null;
  });
  const mark = () => { const p = probe(); return p ? samplePosition(props.map, p.i, p.j) : null; };
  const axisName = (a: number) => AXES[a];
  const db = (x: number | null) => (x === null ? "—" : Number.isFinite(x) ? `${minus(fmt.fixed(x, 1))} dB` : "−∞ dB");

  const maps = () => props.b.field_planes ?? [];
  const pick = (k: number) => {
    const file = resultFocus()?.file ?? designResult()?.file;
    if (file && maps()[k]) focusResult({ file, view: "fieldmap", f: maps()[k].f, map: k }, "main");
  };
  const show3d = () => {
    const file = resultFocus()?.file ?? designResult()?.file;
    if (file) focusResult({ file, view: "fieldplane", f: props.map.f, map: props.index });
  };
  const summary = () => valueLabel(props.map, values(), fieldPlaneScale());

  return (
    <div class="fm">
      <div class="fm-plot" ref={host} tabindex="0" role="group" aria-label={t("fieldMap.plotAria", { label: fieldPlaneLabel(props.map) })}
        aria-describedby="fm-hint" onKeyDown={onKey} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setProbe(null); }}>
        <canvas ref={canvas} class="fm-canvas" style={{ left: `${geom().ox}px`, top: `${geom().oy}px`, width: `${geom().pw}px`, height: `${geom().ph}px` }} />
        <svg class="fm-svg" width={size().w} height={size().h} aria-hidden="true">
          <defs><clipPath id="fm-clip"><rect x={geom().ox} y={geom().oy} width={geom().pw} height={geom().ph} /></clipPath></defs>
          <g class="fm-axis">
            <rect class="fm-frame" x={geom().ox} y={geom().oy} width={geom().pw} height={geom().ph} />
            <For each={xTicks()}>{(v) => (
              <g><line x1={px(v)} x2={px(v)} y1={geom().oy + geom().ph} y2={geom().oy + geom().ph + 4} />
                <text x={px(v)} y={geom().oy + geom().ph + 16} text-anchor="middle">{axisLabel(v, tickStep(xTicks()))}</text></g>
            )}</For>
            <For each={yTicks()}>{(v) => (
              <g><line x1={geom().ox - 4} x2={geom().ox} y1={py(v)} y2={py(v)} />
                <text x={geom().ox - 7} y={py(v) + 4} text-anchor="end">{axisLabel(v, tickStep(yTicks()))}</text></g>
            )}</For>
            <text class="fm-title" x={geom().ox + geom().pw / 2} y={geom().oy + geom().ph + 34} text-anchor="middle">{axisName(props.map.u_axis)} (mm)</text>
            <text class="fm-title" transform={`translate(${Math.max(12, geom().ox - 40)} ${geom().oy + geom().ph / 2}) rotate(-90)`} text-anchor="middle">{axisName(props.map.v_axis)} (mm)</text>
          </g>
          <Show when={showOutline() && outline().length}>
            <g clip-path="url(#fm-clip)" fill="none" stroke-linejoin="round">
              <path class="fm-outline-halo" d={diePath() + metalPath()} />
              <path class="fm-outline-die" d={diePath()} />
              <path class="fm-outline-metal" d={metalPath()} />
            </g>
          </Show>
          <Show when={mark()}>{(p) => (
            <g class="fm-cross">
              <line x1={px(p().u)} x2={px(p().u)} y1={geom().oy} y2={geom().oy + geom().ph} />
              <line x1={geom().ox} x2={geom().ox + geom().pw} y1={py(p().v)} y2={py(p().v)} />
            </g>
          )}</Show>
          <rect x={geom().ox} y={geom().oy} width={geom().pw} height={geom().ph} fill="transparent" style={{ "pointer-events": "all" }}
            onPointerMove={onMove} onPointerLeave={() => setProbe(null)} />
        </svg>
      </div>
      <div class="fm-side">
        <Show when={maps().length > 1}>
          <label class="fm-field"><span>{t("fieldMap.map")}</span>
            <select class="btn btn-ghost btn-sm" onChange={(e) => pick(Number(e.currentTarget.value))}>
              <For each={maps()}>{(m, k) => <option value={k()} selected={k() === props.index}>{fieldPlaneLabel(m)}</option>}</For>
            </select>
          </label>
        </Show>
        <div class="colorbar-title">{fieldPlaneLabel(props.map)}</div>
        <Show when={props.map.port !== undefined}><div class="colorbar-port">{t("viewport.fieldPlane.portDriven", { port: props.map.port })}</div></Show>
        <FieldPlaneControls map={props.map} />
        <FieldPlaneLegend map={props.map} height={150} />
        <div class="colorbar-unit fm-unit">{summary()}{props.map.unit === "arb." ? "" : `, ${t("viewport.fieldPlane.incident")}`}</div>
        <label class="toggle fm-outline-toggle">
          <input type="checkbox" checked={showOutline()} onChange={(e) => setShowOutline(e.currentTarget.checked)} />
          <span class="toggle-box" aria-hidden="true" />
          <span>{t("fieldMap.outline")}</span>
        </label>
        <dl class="kv fm-readout" aria-live="off">
          <Show when={read()} fallback={<><dt>{t("fieldMap.probe")}</dt><dd id="fm-hint" class="muted">{t("fieldMap.probeHint")}</dd></>}>{(r) => (
            <>
              <dt id="fm-hint">{axisName(props.map.u_axis)}</dt><dd class="mono">{sig(r().u)} mm</dd>
              <dt>{axisName(props.map.v_axis)}</dt><dd class="mono">{sig(r().v)} mm</dd>
              <Show when={r().kind === "phase"} fallback={
                <>
                  <dt>{r().kind === "signed" ? t("fieldMap.instant") : t("fieldMap.value")}</dt>
                  <dd class="mono">{sig(r().value)} {props.map.unit}</dd>
                  <Show when={r().kind === "magnitude"}><dt>{t("fieldMap.level")}</dt><dd class="mono">{db(r().db)}</dd></Show>
                </>
              }>
                <dt>{t("fieldMap.phase")}</dt><dd class="mono">{minus(fmt.fixed(r().value, 1))}°</dd>
                <dt>{t("fieldMap.level")}</dt><dd class="mono">{db(r().db)}</dd>
              </Show>
            </>
          )}</Show>
        </dl>
        <button class="btn btn-ghost btn-sm fm-3d" type="button" title={t("fieldMap.show3dTitle")} onClick={show3d}>
          <Globe size={14} aria-hidden="true" /> {t("fieldMap.show3d")}
        </button>
        <p class="rdk-note" role="note">{props.map.normalization === "none" ? t("fieldMap.rawNote") : props.map.phasor ? t("fieldMap.phaseNote") : t("fieldMap.magnitudeNote")}</p>
      </div>
    </div>
  );
}
