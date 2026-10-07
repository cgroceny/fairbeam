import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { useSize } from "./useSize";
import { declutter, localDecimal, minus } from "./labels";
import { freqText } from "../lib/format";
import { t } from "../i18n";

interface Props {
  f: number[];
  re: number[];
  im: number[];
  zRef: number;
  zRe: number[];
  zIm: number[];
  markers: { f: number; label: string }[];
  ariaLabel: string;
  /** label of the main trace when overlays are shown */
  label?: string;
  /** reflection shown, for the tooltip (default S11) */
  quantity?: string;
  /** further traces (e.g. imported reference S11), drawn under the main one */
  overlays?: { label: string; color: string; re: number[]; im: number[] }[];
}

const R_CIRCLES = [0.2, 0.5, 1, 2, 5];
const X_ARCS = [0.2, 0.5, 1, 2, 5];

export default function SmithChart(props: Props) {
  let box: HTMLDivElement | undefined;
  const size = useSize(() => box);
  const [hover, setHover] = createSignal<number | null>(null);
  const clipId = `smith-clip-${Math.random().toString(36).slice(2, 8)}`;

  // With overlays (compared runs) the legend gets its own space, never over the chart: a column
  // on the left of a short, wide chart (the dock), else a strip on top; measured, as it wraps.
  const [legend, setLegend] = createSignal({ w: 0, h: 0 });
  let legendObserver: ResizeObserver | undefined;
  const legendRef = (el: HTMLDivElement) => {
    legendObserver?.disconnect();
    if (typeof ResizeObserver === "undefined") return;
    legendObserver = new ResizeObserver(([e]) => setLegend({ w: Math.ceil(e.contentRect.width), h: Math.ceil(e.contentRect.height) }));
    legendObserver.observe(el);
  };
  onCleanup(() => legendObserver?.disconnect());
  const hasLegend = () => !!props.overlays?.length;
  const sideLegend = () => hasLegend() && size().w >= 360 && size().w >= size().h * 1.8;

  const g = createMemo(() => {
    const { w, h } = size();
    const left = sideLegend() ? legend().w + 24 : 0;
    const top = hasLegend() && !sideLegend() ? legend().h + 12 : 0;
    // 34 px keeps the ±jx labels (placed just outside the rim) inside the box
    const R = Math.max(10, Math.min(w - left, h - top) / 2 - 34);
    return { R, cx: left + (w - left) / 2, cy: top + (h - top) / 2 };
  });
  const X = (u: number) => g().cx + u * g().R;
  const Y = (v: number) => g().cy - v * g().R;

  const trace = () => smithPath(props.re, props.im);
  /** polyline through (re, im), broken where a sample is missing */
  function smithPath(re: number[], im: number[]): string {
    let d = "";
    let pen = false;
    re.forEach((u, i) => {
      if (!Number.isFinite(u) || !Number.isFinite(im[i])) return void (pen = false);
      d += `${pen ? "L" : "M"}${X(u).toFixed(1)},${Y(im[i]).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  const onMove: JSX.EventHandler<SVGSVGElement, PointerEvent> = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const u = (e.clientX - r.left - g().cx) / g().R;
    const v = (g().cy - (e.clientY - r.top)) / g().R;
    if (Math.hypot(u, v) > 1.1) return setHover(null);
    let k = 0;
    let best = Infinity;
    for (let i = 0; i < props.re.length; i++) {
      const d = (props.re[i] - u) ** 2 + (props.im[i] - v) ** 2;
      if (d < best) { best = d; k = i; }
    }
    setHover(best < 0.02 ? k : null);
  };
  const markerIdx = (f: number) => {
    let k = 0;
    for (let i = 1; i < props.f.length; i++) if (Math.abs(props.f[i] - f) < Math.abs(props.f[k] - f)) k = i;
    return k;
  };
  /** Baseline of each real-axis label (r = 0.2 … 5): above the axis, or below it where the trace (or a
   * compared trace) passes through the label's box. */
  const axisLabelY = createMemo(() => {
    const traces = [{ re: props.re, im: props.im }, ...(props.overlays ?? [])];
    const hits = (x0: number, x1: number, y0: number, y1: number) => {
      for (const t of traces) {
        for (let i = 0; i + 1 < t.re.length; i++) {
          const ax = X(t.re[i]), ay = Y(t.im[i]), bx = X(t.re[i + 1]), by = Y(t.im[i + 1]);
          if (![ax, ay, bx, by].every(Number.isFinite)) continue;
          const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 3));
          for (let k = 0; k <= n; k++) {
            const x = ax + ((bx - ax) * k) / n, y = ay + ((by - ay) * k) / n;
            if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return true;
          }
        }
      }
      return false;
    };
    return R_CIRCLES.map((r) => {
      const x0 = X((r - 1) / (r + 1)) + 1, x1 = x0 + 4 + String(r).length * 6.6;
      const above = Y(0) - 4;
      const below = Y(0) + 13;
      return hits(x0, x1, above - 10, above + 3) && !hits(x0, x1, below - 10, below + 3) ? below : above;
    });
  });
  // Marker labels: the real-axis labels sit just above the axis (below it where the trace crosses
  // them), so markers near it label below; nearby markers are decluttered so their labels never overprint.
  const markerPos = createMemo(() => {
    const pts = props.markers.map((m) => {
      const k = markerIdx(m.f);
      const cx = X(props.re[k]);
      const cy = Y(props.im[k]);
      return { cx, cy, x: cx, y: props.im[k] > 0.12 ? cy - 10 : cy + 18, text: m.label, anchor: "middle" as const, mono: true };
    });
    const axis = R_CIRCLES.map((r, i) => ({ x: X((r - 1) / (r + 1)) + 3, y: axisLabelY()[i], text: String(r), anchor: "start" as const, mono: true, fixed: true }));
    const labels = declutter([...pts, ...axis], { top: 14, bottom: size().h - 4 });
    return pts.map((p, i) => ({ cx: p.cx, cy: p.cy, lx: labels[i].x, ly: labels[i].y }));
  });

  return (
    <div class="chart" ref={box}>
      <svg width={size().w} height={size().h} role="img" aria-label={props.ariaLabel} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <defs>
          <clipPath id={clipId}><circle cx={g().cx} cy={g().cy} r={g().R} /></clipPath>
        </defs>
        <circle cx={g().cx} cy={g().cy} r={g().R} class="c-axis-ring" />
        <line x1={X(-1)} x2={X(1)} y1={Y(0)} y2={Y(0)} class="c-grid" />
        <g clip-path={`url(#${clipId})`}>
          <For each={R_CIRCLES}>
            {(r) => <circle cx={X(r / (1 + r))} cy={Y(0)} r={g().R / (1 + r)} class="c-grid-ring" />}
          </For>
          <For each={X_ARCS}>
            {(x) => (
              <>
                <circle cx={X(1)} cy={Y(1 / x)} r={g().R / x} class="c-grid-ring" />
                <circle cx={X(1)} cy={Y(-1 / x)} r={g().R / x} class="c-grid-ring" />
              </>
            )}
          </For>
        </g>
        <For each={R_CIRCLES}>
          {(r, i) => <text x={X((r - 1) / (r + 1)) + 3} y={axisLabelY()[i()]} class="c-tick c-halo">{localDecimal(String(r))}</text>}
        </For>
        <For each={X_ARCS}>
          {(x) => {
            // where the x-arc meets the rim; label sits 8 px outside it, anchored away from the circle
            const gx = (1 - x * x) / (1 + x * x) * -1;
            const gy = (2 * x) / (1 + x * x);
            const px = () => X(gx) + gx * 8;
            const py = (sign: number) => Y(sign * gy) - sign * gy * 8;
            const anchor = gx < -0.2 ? "end" : gx > 0.2 ? "start" : "middle";
            return (
              <>
                <text x={px()} y={py(1)} class="c-tick" text-anchor={anchor} dominant-baseline="middle">+j{localDecimal(String(x))}</text>
                <text x={px()} y={py(-1)} class="c-tick" text-anchor={anchor} dominant-baseline="middle">−j{localDecimal(String(x))}</text>
              </>
            );
          }}
        </For>
        <For each={props.overlays ?? []}>
          {(o) => <path d={smithPath(o.re, o.im)} class="c-line" style={{ stroke: `var(${o.color})` }} />}
        </For>
        <path d={trace()} class="c-line" style={{ stroke: "var(--al-series-1)" }} />
        <For each={props.markers}>
          {(m, i) => {
            const pos = () => markerPos()[i()] ?? { cx: 0, cy: 0, lx: 0, ly: 0 };
            return (
              <g class="c-marker">
                <circle cx={pos().cx} cy={pos().cy} r={4.5} class="c-marker-dot" />
                <text x={pos().lx} y={pos().ly} class="c-marker-label c-halo" text-anchor="middle">{m.label}</text>
              </g>
            );
          }}
        </For>
        <circle cx={X(0)} cy={Y(0)} r={2.5} class="c-origin" />
        <Show when={hover() !== null}>
          <circle cx={X(props.re[hover()!])} cy={Y(props.im[hover()!])} r={5} class="c-cross-dot" style={{ fill: "var(--al-series-1)" }} />
        </Show>
      </svg>
      <Show when={hover() !== null}>
        <div class="chart-tip" style={sideLegend() ? { right: "12px", top: "8px" } : { left: "12px", top: `${hasLegend() ? legend().h + 16 : 8}px` }}>
          <div class="tip-head">{freqText(props.f[hover()!])}</div>
          <div class="tip-row"><span class="tip-val">{localDecimal(props.zRe[hover()!].toFixed(1))} {props.zIm[hover()!] >= 0 ? "+" : "−"} j{localDecimal(Math.abs(props.zIm[hover()!]).toFixed(1))} Ω</span><span class="tip-lbl">Zin</span></div>
          <div class="tip-row"><span class="tip-val">{localDecimal(minus((20 * Math.log10(Math.hypot(props.re[hover()!], props.im[hover()!]))).toFixed(2)))} dB</span><span class="tip-lbl">|{props.quantity ?? "S11"}|</span></div>
        </div>
      </Show>
      <Show when={props.overlays?.length}>
        <div class="chart-legend" classList={{ "smith-legend-side": sideLegend() }} ref={legendRef}>
          <span class="legend-item"><span class="legend-key" style={{ background: "var(--al-series-1)" }} />{props.label ?? "S11"}</span>
          <For each={props.overlays}>{(o) => <span class="legend-item"><span class="legend-key" style={{ background: `var(${o.color})` }} />{o.label}</span>}</For>
        </div>
      </Show>
      <div class="chart-note">{t("chart.smith.normalised", { z: localDecimal(String(props.zRef)) })}</div>
    </div>
  );
}
