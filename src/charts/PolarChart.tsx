import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { useSize } from "./useSize";
import { declutter, localDecimal, minus } from "./labels";
import { t } from "../i18n";
import "../styles/designer-sim.css";

export interface PolarSeries {
  id: string;
  label: string;
  color: string;
  /** signed angle from the zenith in degrees, clockwise positive */
  angle: number[];
  value: number[];
}

interface Props {
  series: PolarSeries[];
  max: number;
  range: number;
  half: boolean;
  unit: string;
  ariaLabel: string;
  /** label each series at its peak (required for series 3, which is below 3:1 on light) */
  directLabels?: boolean;
}

export default function PolarChart(props: Props) {
  let box: HTMLDivElement | undefined;
  const size = useSize(() => box);
  const [hover, setHover] = createSignal<number | null>(null); // hovered angle (deg)

  // Short, wide charts put the legend beside the plot instead of spending its height.
  // Measure the legend in either layout so wrapped comparison names cannot cover the plot.
  let legendEl: HTMLDivElement | undefined;
  const legendSize = useSize(() => legendEl);
  const sideLegend = () => size().h < 240 && size().w >= 360;
  const LEGEND_H = () => sideLegend() ? 0 : Math.max(28, legendSize().h + 16);
  const geo = createMemo(() => {
    const { w, h } = size();
    const left = sideLegend() ? legendSize().w + 24 : 0;
    const pad = h < 240 ? 26 : 34;
    const top = LEGEND_H();
    const avail = Math.max(0, h - top);
    // Horizontal labels need more room than the labels above and below the circle.
    const R = Math.max(10, Math.min((w - left) / 2 - 34, props.half ? avail - pad - 14 : avail / 2 - pad));
    const cx = left + (w - left) / 2;
    // half plane: centre the semicircle (plus its labels) vertically in the free space
    const cy = props.half ? top + Math.max(0, (avail - (R + pad + 14)) / 2) + pad + R : top + avail / 2;
    return { R, cx, cy };
  });
  const lo = () => props.max - props.range;
  const rOf = (v: number) => (Math.max(0, Math.min(props.range, v - lo())) / props.range) * geo().R;
  const pt = (angDeg: number, r: number) => {
    const a = (angDeg * Math.PI) / 180;
    return [geo().cx + r * Math.sin(a), geo().cy - r * Math.cos(a)] as const;
  };
  /** a sample the chart can draw: a number, and above the ground in a half-space chart */
  const drawable = (s: PolarSeries, i: number) => Number.isFinite(s.value[i]) && (!props.half || Math.abs(s.angle[i]) <= 90.0001);
  // missing samples (NaN) break the line into segments; the loop closes only for a complete
  // full-circle cut (a half-space cut drawn on a full chart stays open at the horizon)
  const path = (s: PolarSeries) => {
    let d = "";
    let pen = false;
    s.angle.forEach((a, i) => {
      if (!drawable(s, i)) return void (pen = false);
      const [x, y] = pt(a, rOf(s.value[i]));
      d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      pen = true;
    });
    const span = s.angle.length ? Math.max(...s.angle) - Math.min(...s.angle) : 0;
    const closed = !props.half && span >= 340 && s.value.every((v) => Number.isFinite(v));
    return d + (closed ? "Z" : "");
  };

  const rings = () => [0, 10, 20, 30].filter((d) => d <= props.range);
  // Keep the cardinal bearings in small plots; restore intermediate ticks as room returns.
  const spokes = () => {
    const step = geo().R < 64 ? 90 : geo().R < 100 ? 45 : 30;
    return Array.from({ length: (props.half ? 180 : 360) / step + (props.half ? 1 : 0) }, (_, i) => (props.half ? -90 : -180 + step) + i * step);
  };
  const labelRing = (d: number) => d === 0 || d === rings().at(-1) || geo().R * 10 / props.range >= (props.half ? 32 : 16);

  const onMove: JSX.EventHandler<SVGSVGElement, PointerEvent> = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - r.left - geo().cx;
    const dy = geo().cy - (e.clientY - r.top);
    if (Math.hypot(dx, dy) > geo().R * 1.15) return setHover(null);
    const a = (Math.atan2(dx, dy) * 180) / Math.PI;
    if (props.half && Math.abs(a) > 90) return setHover(null);
    setHover(a);
  };
  // Direct labels: in the free ring outside the angle labels, on each series' peak bearing, pushed
  // apart so they never overprint (inside the plot they collided with the ring and angle ticks).
  // Charts smaller than 420 x 320 px keep the legend only: there is no free ring to label in.
  const peakLabels = createMemo(() => {
    if (!props.directLabels || size().w < 420 || size().h < 320) return [];
    const items = props.series.map((s) => {
      let k = 0;
      for (let i = 1; i < s.value.length; i++) if (drawable(s, i) && (s.value[i] > s.value[k] || !drawable(s, k))) k = i;
      const a = s.angle[k] ?? 0;
      const [x, y] = pt(a, geo().R + 30);
      const side = Math.sin((a * Math.PI) / 180);
      const anchor = (side > 0.2 ? "start" : side < -0.2 ? "end" : "middle") as "start" | "end" | "middle";
      return { x, y: y + 4, text: s.label, anchor };
    });
    const obstacles = spokes().map((a) => {
      const [x, y] = pt(a, geo().R + 15);
      return { x, y: y + 4, text: `${minus(String(a))}°`, anchor: "middle" as const, mono: true, fixed: true };
    });
    return declutter([...items, ...obstacles], { top: LEGEND_H() + 14, bottom: size().h - 4 }).slice(0, items.length);
  });
  const valueAt = (s: PolarSeries, a: number) => {
    let k = -1;
    for (let i = 0; i < s.angle.length; i++) {
      if (!drawable(s, i)) continue;
      if (k < 0 || Math.abs(s.angle[i] - a) < Math.abs(s.angle[k] - a)) k = i;
    }
    return k < 0 ? { angle: a, value: NaN } : { angle: s.angle[k], value: s.value[k] };
  };
  /** The bearing the ring labels sit on. Candidates lie midway between two angle labels, so a ring
   * label never meets a spoke label; the one where the fewest curves cross a label wins (the curves
   * used to run through labels stacked on the back spoke). Ties go to the back (the horizon in half
   * space), where patterns are usually weakest. */
  const ringBearing = createMemo(() => {
    const sp = spokes();
    const step = sp.length > 1 ? sp[1] - sp[0] : 90;
    const cands = props.half
      ? sp.slice(0, -1).map((a) => a + step / 2)
      : sp.map((a) => a - step / 2);
    const radii = rings().filter(labelRing).map((d) => Math.max(rOf(props.max - d), 12));
    const prefer = props.half ? 90 : 180;
    let best = cands[0] ?? prefer;
    let bestCost = Infinity;
    for (const a of cands) {
      let cost = 0;
      for (const s of props.series) {
        for (const b of [a - 3, a, a + 3]) {
          const v = valueAt(s, b);
          if (!Number.isFinite(v.value) || Math.abs(v.angle - b) > 6) continue;
          const rc = rOf(v.value);
          for (const r of radii) if (Math.abs(rc - r) < 9) cost++;
        }
      }
      cost += Math.min(Math.abs(Math.abs(a) - prefer), 180) / 1000;
      if (cost < bestCost) { bestCost = cost; best = a; }
    }
    return best;
  });


  return (
    <div class="chart polar-chart" classList={{ "polar-chart-side": sideLegend() }}
      style={{ "min-height": `${sideLegend() ? 144 : Math.max(144, legendSize().h + 148)}px` }} ref={box}>
      <div class="chart-legend chart-legend-full" role="group" aria-label={t("chart.polar.legendAria")} tabindex="0" ref={legendEl}>
        <For each={props.series}>
          {(s) => (
            <span class="legend-item">
              <span class="legend-key" style={{ background: `var(${s.color})` }} />
              <span>{s.label}</span>
            </span>
          )}
        </For>
        <span class="legend-note">{t("chart.polar.rings", { unit: props.unit })}</span>
      </div>
      <svg width={size().w} height={size().h} role="img" aria-label={props.ariaLabel} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <For each={rings()}>
          {(d) => {
            const r = () => rOf(props.max - d);
            return (
              <g>
                <Show
                  when={props.half}
                  fallback={<circle cx={geo().cx} cy={geo().cy} r={r()} class={d === 0 ? "c-axis-ring" : "c-grid-ring"} />}
                >
                  <path d={`M${geo().cx - r()},${geo().cy} A${r()},${r()} 0 0 1 ${geo().cx + r()},${geo().cy}`} class={d === 0 ? "c-axis-ring" : "c-grid-ring"} />
                </Show>
                <Show when={labelRing(d)}>
                  <text x={pt(ringBearing(), Math.max(r(), 12))[0]} y={pt(ringBearing(), Math.max(r(), 12))[1]} class="c-tick c-halo" text-anchor="middle" dominant-baseline="middle">
                    {minus((props.max - d).toFixed(0))}
                  </text>
                </Show>
              </g>
            );
          }}
        </For>
        <For each={spokes()}>
          {(a) => (
            <g>
              <line x1={geo().cx} y1={geo().cy} x2={pt(a, geo().R)[0]} y2={pt(a, geo().R)[1]} class="c-grid" />
              <text x={pt(a, geo().R + 15)[0]} y={pt(a, geo().R + 15)[1]} class="c-tick" text-anchor="middle" dominant-baseline="middle">{minus(String(a))}°</text>
            </g>
          )}
        </For>
        <For each={props.series}>{(s) => <path d={path(s)} class="c-line" style={{ stroke: `var(${s.color})` }} />}</For>
        <For each={peakLabels()}>
          {(l) => <text x={l.x} y={l.y} class="c-direct c-halo" text-anchor={l.anchor}>{l.text}</text>}
        </For>
        <Show when={hover() !== null}>
          <line x1={geo().cx} y1={geo().cy} x2={pt(hover()!, geo().R)[0]} y2={pt(hover()!, geo().R)[1]} class="c-cross" />
          <For each={props.series}>
            {(s) => {
              const v = () => valueAt(s, hover()!);
              const p = () => pt(v().angle, rOf(v().value));
              return <Show when={Number.isFinite(v().value)}><circle cx={p()[0]} cy={p()[1]} r={4} class="c-cross-dot" style={{ fill: `var(${s.color})` }} /></Show>;
            }}
          </For>
        </Show>
      </svg>
      <Show when={hover() !== null}>
        <div class="chart-tip" style={{ right: "12px", top: `${LEGEND_H()}px` }}>
          <div class="tip-head">θ = {minus(valueAt(props.series[0], hover()!).angle.toFixed(0))}°</div>
          <For each={props.series}>
            {(s) => (
              <div class="tip-row">
                <span class="tip-key" style={{ background: `var(${s.color})` }} />
                <span class="tip-val">{Number.isFinite(valueAt(s, hover()!).value) ? `${localDecimal(minus(valueAt(s, hover()!).value.toFixed(2)))} ${props.unit}` : "—"}</span>
                <span class="tip-lbl">{s.label}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
