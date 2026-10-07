import { createMemo, createSignal, For, Index, type JSX, onCleanup, Show } from "solid-js";
import { niceDomain, ticks, tickLabel, extent } from "./scale";
import { useSize } from "./useSize";
import { declutter, type LabelBox, localDecimal, minus, MONO_ADVANCE, SANS_ADVANCE } from "./labels";
import { findResonances, globalExtrema, isReflectionTrace, nearestFiniteSample, nextMinimum, pickTraceSample } from "./markerMath";
import { chartMarkers, markSeries, nextMarkId, toggleMarkerMode, type ChartMarkers, type UserMark } from "./markerMode";
import { ghzPlain } from "../lib/format";
import { t, tEn } from "../i18n";
import NumberField from "../components/NumberField";
import "../styles/charts.css";

export interface Series {
  id: string;
  label: string;
  /** CSS custom property holding the series colour, e.g. "--al-series-1" */
  color: string;
  x: number[];
  y: number[];
  /** SVG dash array (e.g. "6 4"): a second channel beside the colour, for composite encodings */
  dash?: string;
}

/** The legend/tooltip swatch of a series: its colour, dashed like its line. */
export function seriesKeyStyle(s: { color: string; dash?: string }): JSX.CSSProperties {
  const d = s.dash?.split(/[\s,]+/).map(Number).filter((v) => v > 0);
  if (!d || d.length < 2) return { background: `var(${s.color})` };
  return { background: `repeating-linear-gradient(90deg, var(${s.color}) 0 ${d[0]}px, transparent ${d[0]}px ${d[0] + d[1]}px)` };
}

/** Values known at a few x only (e.g. the radiation efficiency at the far-field frequencies): drawn
 * as symbols, with a legend entry of their own; the shape is a second channel beside the colour. */
export interface PointSeries {
  id: string;
  label: string;
  color: string;
  shape?: "circle" | "diamond";
  x: number[];
  y: number[];
  /** per point: flagged (a ring in the warning colour) with this text in its tooltip */
  warn?: (string | null)[];
}

export interface Marker {
  x: number;
  label: string;
  active?: boolean;
}

export interface LineChartProps {
  series: Series[];
  xLabel: string;
  yLabel: string;
  yDomain?: [number, number];
  /** fixed y ticks (the phase axis: −180, −90, 0, 90, 180), thinned to every other one on a short plot */
  yTickValues?: number[];
  /** tooltip format of x; a frequency axis in GHz always uses the frequency format (lib/format.ts ghzPlain) */
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  hlines?: { y: number; label: string }[];
  bands?: { x0: number; x1: number }[];
  markers?: Marker[];
  /** symbols at single x values (no line), after the series */
  points?: PointSeries[];
  onMarker?: (i: number) => void;
  onPick?: (x: number) => void;
  /** extra rows appended to the crosshair tooltip for the hovered index */
  extra?: (i: number) => { label: string; value: string }[];
  ariaLabel: string;
  /** the marker inspector: `key` names the plotted quantity, `chart` the chart it belongs to (its marker
   * mode, markers and table are kept per chart, markerMode.ts; default: `key`); `toolbar: false` for the
   * lower panes of a stack, which follow the top pane's Markers button */
  inspection?: { key: string; kind: "reflection" | "other"; chart?: string; toolbar?: boolean };
}

export default function LineChart(props: LineChartProps) {
  let box: HTMLDivElement | undefined;
  const size = useSize(() => box);
  const [hover, setHover] = createSignal<number | null>(null);
  // the inspector's state lives in the chart's entry of the marker store (one per chart, not per quantity)
  const chartKey = () => (props.inspection ? props.inspection.chart ?? props.inspection.key : undefined);
  const inspector = () => chartMarkers.get(chartKey());
  const change = (f: (s: ChartMarkers) => ChartMarkers) => chartMarkers.update(chartKey(), f);
  const threshold = () => inspector().threshold;
  const [thresholdInput, setThresholdInput] = createSignal(String(threshold()));
  const enabled = () => inspector().auto;
  const markerMode = () => !!props.inspection && inspector().mode.active;
  const autoShown = () => !!props.inspection && inspector().mode.everOpened;
  const toggleMode = () => change((s) => ({ ...s, mode: toggleMarkerMode(s.mode) }));
  const tableOpen = () => inspector().tableOpen;
  const ownsToolbar = () => props.inspection?.toolbar !== false;
  const userMarks = () => (props.inspection ? inspector().marks : []);
  const [status, setStatus] = createSignal("");
  let dragging: number | null = null;
  // reactive: the active marker is highlighted, and the toolbar acts on it
  const [selectedId, setSelectedId] = createSignal<number | null>(null);
  const saveMarks = (marks: UserMark[]) => change((s) => ({ ...s, marks }));
  const seriesOf = (m: UserMark) => markSeries(props.series, m.seriesId);
  const nearestFinite = (s: Series, x: number) => nearestFiniteSample(s.x, s.y, x)?.index ?? -1;
  // the legend strip wraps (many compared runs): the plot starts below its measured height
  const [legendH, setLegendH] = createSignal(16);
  let legendObserver: ResizeObserver | undefined;
  let legendFrame = 0;
  const legendRef = (el: HTMLDivElement) => {
    legendObserver?.disconnect();
    if (typeof ResizeObserver === "undefined") return;
    // applied in the next frame: the plot moving under the legend must not resize it in the same
    // observer pass (useSize.ts)
    legendObserver = new ResizeObserver(([e]) => {
      const h = Math.max(16, Math.ceil(e.contentRect.height));
      cancelAnimationFrame(legendFrame);
      legendFrame = requestAnimationFrame(() => { if (legendH() !== h) setLegendH(h); });
    });
    legendObserver.observe(el);
  };
  onCleanup(() => { cancelAnimationFrame(legendFrame); legendObserver?.disconnect(); });
  const isTextEntry = (target: EventTarget | null) => target instanceof Element && !!target.closest("input, textarea, select, [contenteditable='true']");
  const onMarkerShortcut = (e: KeyboardEvent) => {
    if ((e.key !== "m" && e.key !== "M") || e.ctrlKey || e.altKey || e.metaKey || isTextEntry(e.target)) return;
    const chart = box;
    if (!chart || !props.inspection) return;
    // the dock, or a result tab of the designer's main area
    const dock = chart.closest(".dock, .rdk, .dw-result");
    const focusedChart = (document.activeElement as Element | null)?.closest(".chart-inspector-wrap");
    const dockActive = !!dock && dock.contains(document.activeElement);
    if (!focusedChart && !dockActive) return;
    if (focusedChart && focusedChart !== chart.parentElement) return;
    if (!focusedChart && dock) {
      const first = [...dock.querySelectorAll<HTMLElement>(".chart-inspector-wrap")].find(el => el.offsetWidth && el.offsetHeight);
      if (first !== chart.parentElement) return;
    }
    e.preventDefault(); toggleMode();
  };
  document.addEventListener("keydown", onMarkerShortcut);
  onCleanup(() => document.removeEventListener("keydown", onMarkerShortcut));

  const xs = () => props.series[0]?.x ?? [];
  const xDom = createMemo<[number, number]>(() => {
    const x = xs();
    return x.length ? [x[0], x[x.length - 1]] : [0, 1];
  });
  const yDom = createMemo<[number, number]>(() => {
    if (props.yDomain) return props.yDomain;
    const [lo, hi] = extent([...props.series.map((s) => s.y), ...(props.points ?? []).map((p) => p.y)]);
    const pad = (hi - lo) * 0.06 || 1;
    return niceDomain(lo - pad, hi + pad, 5);
  });
  // Margins: the left gutter fits the widest y-tick label; the top strip holds the legend.
  const M = {
    get l() {
      return gutter();
    },
    get r() {
      return rightGutter();
    },
    get t() {
      return legendCount() > 1 ? legendH() + 16 : 16;
    },
    b: 40,
  };
  const legendCount = () => props.series.length + (props.points?.length ?? 0);
  // Direct series labels (2-4 series) sit in a gutter to the right of the plot, not over the curves.
  // Only a series that ends within the right 15 % of the x range gets one (a series that stops
  // earlier is named by the legend); the gutter fits the widest such label, up to 30 % of the width.
  const END_GAP = 8;
  const lastFinite = (s: Series) => {
    for (let i = Math.min(s.x.length, s.y.length) - 1; i >= 0; i--) if (Number.isFinite(s.y[i]) && Number.isFinite(s.x[i])) return i;
    return -1;
  };
  const gutterSeries = createMemo(() => {
    if (props.series.length < 2 || props.series.length > 4) return [];
    const [x0, x1] = xDom();
    return props.series.filter((s) => {
      const k = lastFinite(s);
      return k >= 0 && (s.x[k] - x0) / (x1 - x0 || 1) >= 0.85;
    });
  });
  const rightGutter = createMemo(() => {
    const labels = gutterSeries();
    if (!labels.length) return 20;
    const want = Math.max(...labels.map((s) => s.label.length)) * SANS_ADVANCE + END_GAP + 4;
    return Math.round(Math.max(20, Math.min(want, size().w * 0.3)));
  });
  const clipLabel = (text: string) => {
    const max = Math.max(3, Math.floor((rightGutter() - END_GAP - 4) / SANS_ADVANCE));
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
  const W = () => Math.max(0, size().w - M.l - M.r);
  const H = () => Math.max(0, size().h - M.t - M.b);
  const sx = (v: number) => M.l + ((v - xDom()[0]) / (xDom()[1] - xDom()[0] || 1)) * W();
  const sy = (v: number) => {
    const [lo, hi] = yDom();
    const c = Math.min(hi, Math.max(lo, v));
    return M.t + (1 - (c - lo) / (hi - lo || 1)) * H();
  };
  // y ticks depend on the plot height only (not on the left gutter), so no cycle with M.l: at least three
  // on a plot tall enough for them (a short stacked pane), one per 44 px above that
  const yTicks = createMemo(() => {
    const h = size().h - M.t - M.b;
    const [lo, hi] = yDom();
    if (props.yTickValues?.length) {
      const inside = props.yTickValues.filter((v) => v >= lo - 1e-9 && v <= hi + 1e-9);
      return inside.length > 3 && h / (inside.length - 1) < 22 ? inside.filter((_, i) => i % 2 === 0) : inside;
    }
    return ticks(lo, hi, Math.max(h >= 56 ? 3 : 2, Math.floor(h / 44)));
  });
  // axis ticks use step-aware precision (0, −10, −20 rather than 0.0, −10.0); tooltips use x/yFormat
  const fx = (v: number) => localDecimal(minus(tickLabel(v, (xTicks()[1] ?? 1) - (xTicks()[0] ?? 0))));
  const fy = (v: number) => localDecimal(minus(tickLabel(v, (yTicks()[1] ?? 1) - (yTicks()[0] ?? 0))));
  // plain: with the decimal point (the copied marker table); tx/ty: as shown. A frequency in GHz has one
  // format everywhere it is read off a chart (four significant digits: lib/format.ts ghzPlain)
  const txPlain = (v: number) => (xUnit() === "GHz" ? ghzPlain(v) : props.xFormat ? props.xFormat(v) : v.toFixed(4));
  const tyPlain = (v: number) => minus((props.yFormat ?? ((n: number) => n.toFixed(2)))(v));
  const tx = (v: number) => localDecimal(txPlain(v));
  const ty = (v: number) => localDecimal(tyPlain(v));
  // units come from the axis titles, e.g. "Zin (Ω)" -> "Ω"; the tooltip shows them with every value
  const unitOf = (label: string) => label.match(/\(([^)]+)\)\s*$/)?.[1] ?? "";
  const xUnit = () => unitOf(props.xLabel);
  const yUnit = () => unitOf(props.yLabel);
  const gutter = createMemo(() => {
    const chars = Math.max(...yTicks().map((t) => fy(t).length), 2);
    return Math.round(34 + chars * MONO_ADVANCE);
  });
  const xTicks = createMemo(() => ticks(xDom()[0], xDom()[1], Math.max(2, Math.floor(W() / 90))));

  const path = (s: Series) => {
    let d = "", open = false;
    for (let i = 0; i < Math.min(s.x.length, s.y.length); i++) {
      if (!Number.isFinite(s.x[i]) || !Number.isFinite(s.y[i])) { open = false; continue; }
      d += `${open ? "L" : "M"}${sx(s.x[i]).toFixed(1)},${sy(s.y[i]).toFixed(1)}`;
      open = true;
    }
    return d;
  };

  const onMove: JSX.EventHandler<SVGSVGElement, PointerEvent> = (e) => {
    if (dragging !== null) { inspectPointer(e); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const x = xDom()[0] + ((px - M.l) / (W() || 1)) * (xDom()[1] - xDom()[0]);
    if (px < M.l - 4 || px > M.l + W() + 4) return setHover(null);
    const first = props.series[0];
    setHover(first ? nearestFiniteSample(first.x, first.y, x)?.index ?? null : null);
  };
  const reflection = (s: Series) => props.inspection?.kind === "reflection" && isReflectionTrace(s.id.replace(/:(db|phase|re|im|mag)$/, ""));
  const autoRows = createMemo(() => props.series.flatMap(s => {
    if (!autoShown() || !enabled()) return [];
    if (reflection(s)) return Number.isFinite(threshold()) ? findResonances(s.x, s.y, threshold()).map((r, n) => ({ marker: `R${n + 1}`, sid: s.id, trace: s.label, f: r.x, value: r.y, low: r.low, high: r.high, percent: r.percent, edgeLow: r.edgeLow, edgeHigh: r.edgeHigh, flagLow: r.edgeLow, flagHigh: r.edgeHigh })) : [];
    const e = globalExtrema(s.x, s.y);
    return [e.min && { marker: "min", sid: s.id, trace: s.label, f: e.min.x, value: e.min.y }, e.max && { marker: "max", sid: s.id, trace: s.label, f: e.max.x, value: e.max.y }].filter(Boolean) as any[];
  }));
  const inspectionRows = createMemo(() => {
    const rows: any[] = [...autoRows()];
    for (const m of userMarks()) { const s = seriesOf(m); const i = s ? nearestFinite(s, m.x) : -1; if (s && i >= 0) rows.push({ marker: `M${m.id}`, trace: s.label, f: s.x[i], value: s.y[i] }); }
    const shown = userMarks().flatMap(m => { const s = seriesOf(m); const p = s && nearestFiniteSample(s.x, s.y, m.x); return p ? [{ f: p.x, v: p.y }] : []; });
    if (shown.length === 2) rows.push({ marker: "Δ", trace: null, f: shown[1].f - shown[0].f, value: shown[1].v - shown[0].v });
    return rows;
  });
  const ensureSelected = () => {
    let mark = userMarks().find(m => m.id === selectedId());
    if (!mark) {
      const s = props.series[0];
      if (!s) return null;
      const p = props.inspection?.kind === "reflection" ? findResonances(s.x, s.y, threshold())[0] : null;
      const point = p ?? globalExtrema(s.x, s.y).min;
      if (!point) return null;
      mark = { id: nextMarkId(userMarks()), seriesId: s.id, x: point.x };
      setSelectedId(mark.id);
      saveMarks([...userMarks(), mark]);
    }
    return mark;
  };
  const jumpMinimum = (id: number | null, direction: -1 | 1) => {
    const mark = id === null ? ensureSelected() : userMarks().find(m => m.id === id) ?? ensureSelected();
    const s = mark && seriesOf(mark);
    if (!mark || !s) return;
    const from = nearestFinite(s, mark.x);
    const next = nextMinimum(s.x, s.y, from, direction);
    if (next) saveMarks(userMarks().map(m => m.id === mark!.id ? { ...m, x: next.x } : m));
    setSelectedId(mark.id);
  };
  // keyboard route to a new marker: the next minimum after the active one, or the first resonance
  const addMarker = () => {
    const from = userMarks().find(m => m.id === selectedId());
    const s = from && seriesOf(from);
    const next = s && nextMinimum(s.x, s.y, nearestFinite(s, from!.x), 1);
    if (!s || !next) { setSelectedId(null); ensureSelected(); return; }
    const mark = { id: nextMarkId(userMarks()), seriesId: s.id, x: next.x };
    setSelectedId(mark.id);
    saveMarks([...userMarks(), mark]);
  };
  const removeMarker = (id: number) => {
    saveMarks(userMarks().filter(m => m.id !== id));
    if (selectedId() === id) setSelectedId(null);
  };
  // table/TSV cells: the frequency format of the readouts and tooltips (four significant digits in GHz);
  // an open-ended band shows its known bound and a lower-bound %
  const fxCellPlain = (v: number) => minus(txPlain(v));
  const fxCell = (v: number) => localDecimal(fxCellPlain(v));
  const withUnit = (v: string, unit: string) => (unit ? `${v} ${unit}` : v);
  // plain: the copied table (English, decimal point, like Copy data); else as shown
  const cells = (r: any, plain = false): string[] => {
    const tr = plain ? tEn : t, X = plain ? fxCellPlain : fxCell, Y = plain ? tyPlain : ty, D = plain ? (s: string) => s : localDecimal;
    const flags = [r.flagLow && tr("chart.flag.openBelow"), r.flagHigh && tr("chart.flag.openAbove")].filter(Boolean).join(", ");
    return [
      r.marker, r.trace ?? tr("chart.userMarkers"), X(r.f), Y(r.value),
      r.low === undefined ? "" : `${r.edgeLow ? "≤ " : ""}${X(r.low)}`,
      r.high === undefined ? "" : `${r.edgeHigh ? "≥ " : ""}${X(r.high)}`,
      r.percent === undefined || !Number.isFinite(r.percent) ? "" : `${r.edgeLow || r.edgeHigh ? "≥ " : ""}${D(r.percent.toFixed(2))}%`,
      // the difference of the two user markers, with the axes' units: "Δf −0.2196 GHz · Δ 9.7 dB"
      flags || (r.marker === "Δ" ? tr("chart.deltaCell", { df: withUnit(X(r.f), xUnit()), dv: withUnit(Y(r.value), yUnit()) }) : ""),
    ];
  };
  const unitSuffix = (u: string) => (u ? ` (${u})` : "");
  const headers = (plain = false) => {
    const tr = plain ? tEn : t;
    return [tr("chart.col.marker"), tr("chart.col.trace"), `f${unitSuffix(xUnit())}`, `${tr("chart.col.value")}${unitSuffix(yUnit())}`, `${tr("chart.col.low")}${unitSuffix(xUnit())}`, `${tr("chart.col.high")}${unitSuffix(xUnit())}`, tr("chart.col.bw"), tr("chart.col.flags")];
  };
  const inspectPointer = (e: PointerEvent) => {
    const r = e.currentTarget instanceof SVGSVGElement ? e.currentTarget.getBoundingClientRect() : box!.getBoundingClientRect();
    const xval = xDom()[0] + (((e.clientX - r.left) - M.l) / (W() || 1)) * (xDom()[1] - xDom()[0]);
    if (dragging !== null) { const mark = userMarks().find(m => m.id === dragging); if (mark) { const s = seriesOf(mark); const p = s && nearestFiniteSample(s.x, s.y, xval); if (p) saveMarks(userMarks().map(m => m.id === dragging ? { ...m, x: p.x } : m)); } return; }
    const best = pickTraceSample(props.series, xval, e.clientY - r.top, sy);
    if (best && props.inspection) { const mark = { id: nextMarkId(userMarks()), seriesId: best.trace.id, x: best.point.x }; setSelectedId(mark.id); saveMarks([...userMarks(), mark]); }
  };

  // Tooltip sits beside the crosshair and flips to the left in the right half of the plot.
  const tipFlip = () => {
    const i = hover();
    return i !== null && sx(xs()[i]) > M.l + W() / 2;
  };
  const tipLeft = () => {
    const i = hover();
    if (i === null) return 0;
    const x = sx(xs()[i]);
    return tipFlip() ? x - 12 : x + 12;
  };

  // Reference-line labels stay at the plot's right end (decluttered); the direct series labels
  // stand in the right gutter at the height of each curve's last point, decluttered among themselves.
  const endLabels = createMemo(() => {
    const xr = M.l + W() - 4;
    const items: (LabelBox & { cls: string })[] = [];
    for (const h of props.hlines ?? []) {
      if (h.label) items.push({ x: xr, y: sy(h.y) - 5, text: minus(h.label), anchor: "end", mono: true, cls: "c-ref-label" });
    }
    return declutter(items, { top: M.t + 11, bottom: M.t + H() - 4 });
  });
  const gutterLabels = createMemo(() => {
    const xg = M.l + W() + END_GAP;
    const items: (LabelBox & { full: string })[] = gutterSeries().map((s) => {
      const k = lastFinite(s);
      return { x: xg, y: sy(s.y[k]) + 4, text: clipLabel(s.label), full: s.label, anchor: "start" as const };
    });
    return declutter(items, { top: M.t + 11, bottom: M.t + H() - 4 });
  });

  /** the bandwidth caption over a resonance (only where it has room and the band is closed) */
  const bwText = (r: any) =>
    xUnit() === "GHz" && r.low !== undefined && r.high !== undefined && autoRows().length <= 3 && !r.edgeLow && !r.edgeHigh && Math.abs(sx(r.high) - sx(r.low)) > 120
      ? t("chart.bwLabel", { bw: localDecimal(((r.high - r.low) * 1000).toFixed(2)), percent: localDecimal(r.percent.toFixed(2)) })
      : null;
  // Labels of the automatic markers (R1, min, max) and the user's (M1, M2, …) go through one declutter
  // pass, so two markers on the same dip stack upward instead of overprinting. The end labels and the
  // bandwidth captions are obstacles that stay where they are.
  // A label centred on a point near the plot's left or right end is moved inside the plot, so it never
  // sits over the y-axis tick labels (a far-field marker at the first frequency read "−28.00").
  const insideX = (x: number, text: string) => {
    const half = (text.length * MONO_ADVANCE) / 2 + 2;
    return W() > 2 * half ? Math.min(Math.max(x, M.l + half), M.l + W() - half) : x;
  };
  const markLabels = createMemo(() => {
    const items: (LabelBox & { key: string })[] = [];
    const fixed: LabelBox[] = endLabels().map((d) => ({ x: d.x, y: d.y, text: d.text, anchor: d.anchor, mono: d.mono, fixed: true }));
    for (const r of autoRows()) {
      const s = props.series.find((q) => q.id === r.sid);
      const p = s && nearestFiniteSample(s.x, s.y, r.f);
      if (!p) continue;
      const text = `${r.marker}${r.edgeLow ? " ◀" : ""}${r.edgeHigh ? " ▶" : ""}`;
      items.push({ key: `a:${r.marker}:${r.sid}`, x: insideX(sx(p.x), text), y: sy(p.y) - 7, text, anchor: "middle", mono: true });
      const bw = bwText(r);
      // drawn at -17; the obstacle sits a little higher so the marker label just under it is not pushed above it
      if (bw) fixed.push({ x: sx(p.x), y: sy(p.y) - 22, text: bw, anchor: "middle", mono: true, fixed: true });
    }
    for (const m of userMarks()) {
      const s = seriesOf(m);
      const i = s ? nearestFinite(s, m.x) : -1;
      if (s && i >= 0) items.push({ key: `m:${m.id}`, x: insideX(sx(s.x[i]), `M${m.id}`), y: sy(s.y[i]) - 10, text: `M${m.id}`, anchor: "middle", mono: true });
    }
    const out = items.length ? declutter([...items, ...fixed], { top: M.t + 11, bottom: M.t + H() - 2 }, 1, true) : [];
    return new Map(items.map((it, i) => [it.key, { x: it.x, y: out[i].y }]));
  });

  // Marker labels: below the dot unless that would reach the x-axis tick labels; inside the plot; decluttered.
  const markerPos = createMemo(() => {
    const s0 = props.series[0];
    const arr = s0?.x ?? [];
    const pts = (props.markers ?? []).map((m) => {
      let k = 0;
      for (let j = 1; j < arr.length; j++) if (Math.abs(arr[j] - m.x) < Math.abs(arr[k] - m.x)) k = j;
      const cx = sx(m.x);
      const cy = sy(s0?.y[k] ?? 0);
      return { cx, cy, x: insideX(cx, m.label), y: cy + 20 > M.t + H() - 2 ? cy - 11 : cy + 20, text: m.label, anchor: "middle" as const, mono: true };
    });
    const labels = declutter(pts, { top: M.t + 11, bottom: M.t + H() - 2 });
    return pts.map((p, i) => ({ cx: p.cx, cy: p.cy, lx: labels[i].x, ly: labels[i].y }));
  });
  // the y-axis title fits the plot's height: shortened with an ellipsis (the full title as a tooltip)
  // rather than cut off at the chart's edge on a short pane
  const yTitle = createMemo(() => {
    // centred on the plot: the top margin is the narrower side
    const room = Math.max(3, Math.floor((H() + 2 * M.t - 4) / SANS_ADVANCE));
    return props.yLabel.length <= room ? props.yLabel : `${props.yLabel.slice(0, Math.max(1, room - 1))}…`;
  });

  return (
    <div class="chart-container" classList={{ "chart-inspector-wrap": !!props.inspection }}>
    <div class="chart" ref={box}>
      <Show when={legendCount() > 1}>
        <div class="chart-legend" aria-hidden="true" style={{ left: `${M.l}px` }} ref={legendRef}>
          <For each={props.series}>
            {(s) => (
              <span class="legend-item">
                <span class="legend-key" style={seriesKeyStyle(s)} />
                {s.label}
              </span>
            )}
          </For>
          <For each={props.points ?? []}>
            {(p) => (
              <span class="legend-item">
                <span class={`legend-key legend-point legend-point-${p.shape ?? "circle"}`} style={{ background: `var(${p.color})` }} />
                {p.label}
              </span>
            )}
          </For>
        </div>
      </Show>
      <svg
        width={size().w}
        height={size().h}
        role="img"
        aria-label={props.ariaLabel}
        onPointerMove={onMove}
        onPointerDown={(e) => { if (markerMode() && props.inspection && e.button === 0 && !(e.target as Element).closest(".c-marker")) { inspectPointer(e); e.stopPropagation(); } }}
        onPointerUp={() => { dragging = null; }}
        onPointerCancel={() => { dragging = null; }}
        onPointerLeave={() => { if (dragging === null) setHover(null); }}
        onClick={() => {
          const i = hover();
          // marker mode owns plot clicks; otherwise a click keeps its plot action (Examples: far-field frequency)
          if (i !== null && !(props.inspection && markerMode())) props.onPick?.(xs()[i]);
        }}
      >
        <For each={props.bands ?? []}>
          {(b) => <rect x={sx(b.x0)} y={M.t} width={Math.max(1, sx(b.x1) - sx(b.x0))} height={H()} class="c-band" />}
        </For>
        <For each={autoRows().filter(r => r.low !== undefined && r.high !== undefined)}>
          {(r) => <rect x={sx(r.low)} y={M.t} width={Math.max(1, sx(r.high) - sx(r.low))} height={H()} class="c-band" />}
        </For>
        <For each={yTicks()}>
          {(t) => (
            <g>
              <line x1={M.l} x2={M.l + W()} y1={sy(t)} y2={sy(t)} class="c-grid" />
              <text x={M.l - 8} y={sy(t)} class="c-tick" text-anchor="end" dominant-baseline="middle">{fy(t)}</text>
            </g>
          )}
        </For>
        <For each={xTicks()}>
          {(t) => (
            <text x={sx(t)} y={M.t + H() + 18} class="c-tick" text-anchor="middle">{fx(t)}</text>
          )}
        </For>
        <line x1={M.l} x2={M.l + W()} y1={M.t + H()} y2={M.t + H()} class="c-axis" />
        <text x={M.l + W()} y={size().h - 4} class="c-label" text-anchor="end">{props.xLabel}</text>
        <text x={14} y={M.t + H() / 2} class="c-label" text-anchor="middle" transform={`rotate(-90 12 ${M.t + H() / 2})`}>
          <Show when={yTitle() !== props.yLabel}><title>{props.yLabel}</title></Show>{yTitle()}
        </text>

        <For each={props.hlines ?? []}>
          {(h) => (
            <g>
              <line x1={M.l} x2={M.l + W()} y1={sy(h.y)} y2={sy(h.y)} class="c-ref" />
            </g>
          )}
        </For>

        <For each={props.series}>
          {(s) => <path d={path(s)} class="c-line" style={{ stroke: `var(${s.color})`, "stroke-dasharray": s.dash }} />}
        </For>

        <For each={props.points ?? []}>
          {(p) => (
            <g class="c-points" role="list" aria-label={p.label}>
              <For each={p.x}>{(x, i) => (
                <Show when={Number.isFinite(x) && Number.isFinite(p.y[i()])}>
                  <g role="listitem" aria-label={t("chart.pointAt", { label: p.label, value: `${ty(p.y[i()])} ${yUnit()}`.trim(), at: `${tx(x)} ${xUnit()}`.trim() })}>
                    <title>{`${t("chart.pointAt", { label: p.label, value: `${ty(p.y[i()])} ${yUnit()}`.trim(), at: `${tx(x)} ${xUnit()}`.trim() })}${p.warn?.[i()] ? ` · ${p.warn[i()]}` : ""}`}</title>
                    <Show when={p.warn?.[i()]}><circle cx={sx(x)} cy={sy(p.y[i()])} r={8.5} class="c-point-warn" /></Show>
                    <Show when={(p.shape ?? "circle") === "diamond"} fallback={<circle cx={sx(x)} cy={sy(p.y[i()])} r={4.5} class="c-point" style={{ fill: `var(${p.color})` }} />}>
                      <path d={`M${sx(x)},${sy(p.y[i()]) - 6}l6,6l-6,6l-6,-6z`} class="c-point" style={{ fill: `var(${p.color})` }} />
                    </Show>
                  </g>
                </Show>
              )}</For>
            </g>
          )}
        </For>

        <For each={autoRows()}>{(r) => {
          const s = props.series.find((q) => q.id === r.sid);
          const p = s && nearestFiniteSample(s.x, s.y, r.f);
          return <Show when={s && p}>
            <g aria-hidden="true">
              <Show when={r.low !== undefined && r.high !== undefined}>
                <circle cx={sx(r.low)} cy={sy(threshold())} r="3" class="c-bw-edge c-bw-left"><title>{t("chart.lowCrossing", { f: `${fxCell(r.low)} ${xUnit()}`.trim(), value: `${ty(threshold())} ${yUnit()}`.trim() })}</title></circle>
                <circle cx={sx(r.high)} cy={sy(threshold())} r="3" class="c-bw-edge c-bw-right"><title>{t("chart.highCrossing", { f: `${fxCell(r.high)} ${xUnit()}`.trim(), value: `${ty(threshold())} ${yUnit()}`.trim() })}</title></circle>
                <Show when={bwText(r)}>
                  <text x={sx(p!.x)} y={sy(p!.y)-17} class="c-bw-label c-halo" text-anchor="middle">{bwText(r)}</text>
                </Show>
              </Show>
              <circle cx={sx(p!.x)} cy={sy(p!.y)} r="3.5" class="c-marker-dot"><title>{r.low !== undefined ? t("chart.dip") : r.marker} {fxCell(r.f)} {xUnit()}, {ty(r.value)} {yUnit()}</title></circle>
              <text x={markLabels().get(`a:${r.marker}:${r.sid}`)?.x ?? sx(p!.x)} y={markLabels().get(`a:${r.marker}:${r.sid}`)?.y ?? sy(p!.y) - 7} class="c-marker-label c-halo" text-anchor="middle">{r.marker}{r.edgeLow ? " ◀" : ""}{r.edgeHigh ? " ▶" : ""}</text>
            </g>
          </Show>;
        }}</For>

        <For each={endLabels()}>
          {(d) => <text x={d.x} y={d.y} class={`${d.cls} c-halo`} text-anchor="end">{d.text}</text>}
        </For>
        <For each={gutterLabels()}>
          {(d) => <text x={d.x} y={d.y} class="c-direct" text-anchor="start"><title>{d.full}</title>{d.text}</text>}
        </For>

        <For each={props.markers ?? []}>
          {(m, i) => {
            const pos = () => markerPos()[i()] ?? { cx: 0, cy: 0, lx: 0, ly: 0 };
            return (
              <g
                class="c-marker"
                classList={{ active: !!m.active }}
                role="button"
                tabindex={0}
                aria-label={m.label}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onMarker?.(i());
                }}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && props.onMarker?.(i())}
              >
                <circle cx={pos().cx} cy={pos().cy} r={14} class="c-marker-hit" />
                <circle cx={pos().cx} cy={pos().cy} r={4.5} class="c-marker-dot" />
                <text x={pos().lx} y={pos().ly} class="c-marker-label c-halo" text-anchor="middle">{m.label}</text>
              </g>
            );
          }}
        </For>

        <Index each={userMarks()}>{(m) => {
          const s = () => seriesOf(m());
          const i = () => s() ? nearestFinite(s()!, m().x) : -1;
          return <Show when={s() && i() >= 0}>
            <g class="c-marker" classList={{ active: selectedId() === m().id }} tabindex={0} role="button" aria-label={t("chart.markerAria", { id: `M${m().id}` })}
              onFocus={() => setSelectedId(m().id)}
              onPointerDown={(e) => {
                if (!markerMode()) return;
                e.stopPropagation();
                setSelectedId(m().id);
                dragging = m().id;
                e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId);
              }}
              onKeyDown={(e) => {
                if (markerMode() && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); removeMarker(m().id); }
                if (markerMode() && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                  e.preventDefault();
                  jumpMinimum(m().id, e.key === "ArrowLeft" ? -1 : 1);
                }
              }}>
              <circle cx={sx(s()!.x[i()])} cy={sy(s()!.y[i()])} r={7} class="c-marker-dot" style={{ stroke: `var(${s()!.color})` }} />
              <text x={markLabels().get(`m:${m().id}`)?.x ?? sx(s()!.x[i()])} y={markLabels().get(`m:${m().id}`)?.y ?? sy(s()!.y[i()]) - 10} class="c-marker-label c-halo" text-anchor="middle">M{m().id}</text>
            </g>
          </Show>;
        }}</Index>

        <Show when={hover() !== null}>
          <line x1={sx(xs()[hover()!])} x2={sx(xs()[hover()!])} y1={M.t} y2={M.t + H()} class="c-cross" />
          <For each={props.series}>
            {(s) => (
              <Show when={nearestFinite(s, xs()[hover()!]) >= 0}>
                <circle cx={sx(s.x[nearestFinite(s, xs()[hover()!])])} cy={sy(s.y[nearestFinite(s, xs()[hover()!])])} r={4} class="c-cross-dot" style={{ fill: `var(${s.color})` }} />
              </Show>
            )}
          </For>
        </Show>
      </svg>
      <Show when={hover() !== null}>
        <div class="chart-tip" classList={{ "flip-x": tipFlip() }} style={{ left: `${tipLeft()}px`, top: `${M.t + 4}px` }}>
          <div class="tip-head">{tx(xs()[hover()!])} {xUnit() || `· ${props.xLabel}`}</div>
          <For each={props.series}>
            {(s) => (
              <div class="tip-row">
                <span class="tip-key" style={seriesKeyStyle(s)} />
                <span class="tip-val">{nearestFinite(s, xs()[hover()!]) >= 0 ? `${ty(s.y[nearestFinite(s, xs()[hover()!])])} ${yUnit()}`.trim() : "—"}</span>
                <span class="tip-lbl">{nearestFinite(s, xs()[hover()!]) >= 0 && s.x[nearestFinite(s, xs()[hover()!])] !== xs()[hover()!] ? tx(s.x[nearestFinite(s, xs()[hover()!])]) : ""}</span>
                <span class="tip-lbl">{s.label}</span>
              </div>
            )}
          </For>
          <For each={props.extra?.(hover()!) ?? []}>
            {(r) => (
              <div class="tip-row tip-extra">
                <span class="tip-val">{minus(r.value)}</span>
                <span class="tip-lbl">{r.label}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      </div>
      <Show when={props.inspection && (ownsToolbar() || markerMode())}>
        <section class="chart-inspector-panel" classList={{ "is-open": markerMode() && tableOpen() }} aria-label={t("chart.inspector")}>
          {/* one Markers button per chart: the lower panes of a stack follow the top pane's */}
          <Show when={ownsToolbar()}>
            <div class="chart-inspector-toolbar"><button type="button" class="btn btn-ghost btn-sm" aria-pressed={markerMode()} onClick={toggleMode}>{t("markers.toggle")}</button></div>
          </Show>
          <Show when={markerMode() && ownsToolbar()}><div class="chart-inspector-tools">
            <label><input type="checkbox" checked={enabled()} onChange={e => { const auto = e.currentTarget.checked; change((s) => ({ ...s, auto })); }} /> {t("markers.automatic")}</label>
            <Show when={props.inspection?.kind === "reflection"}>
              <label>{t("markers.threshold")} <NumberField aria-label={t("markers.thresholdAria")} value={thresholdInput()} onInput={e => { const raw = e.currentTarget.value; setThresholdInput(raw); const n = Number(raw); if (raw.trim() !== "" && Number.isFinite(n)) change((s) => ({ ...s, threshold: n })); }} /> dB</label>
            </Show>
            <button type="button" class="btn btn-ghost btn-sm" onClick={addMarker}>{t("markers.add")}</button>
            <button type="button" class="btn btn-ghost btn-sm" onClick={() => jumpMinimum(selectedId(), -1)}>{t("markers.previousMinimum")}</button>
            <button type="button" class="btn btn-ghost btn-sm" onClick={() => jumpMinimum(selectedId(), 1)}>{t("markers.nextMinimum")}</button>
            <button type="button" class="btn btn-ghost btn-sm" onClick={async () => {
              try {
                const lines = [headers(true), ...inspectionRows().map((r) => cells(r, true))].map(r => r.join("\t"));
                await navigator.clipboard.writeText(lines.join("\n")); setStatus(t("markers.copied"));
              } catch { setStatus(t("markers.copyFailed")); }
            }}>{t("markers.copy")}</button>
            <button type="button" class="btn btn-ghost btn-sm" onClick={() => { saveMarks([]); setSelectedId(null); }}>{t("markers.clear")}</button>
            <button type="button" class="btn btn-ghost btn-sm" aria-expanded={tableOpen()} onClick={() => change((s) => ({ ...s, tableOpen: !s.tableOpen }))}> {tableOpen() ? t("markers.hideTable") : t("markers.showTable")}</button>
            <span role="status" aria-live="polite">{status()}</span>
          </div></Show>
          <Show when={markerMode() && tableOpen()}><div class="chart-inspector-table-wrap">
            <table class="chart-inspector-table">
              <thead><tr><For each={headers()}>{(h) => <th scope="col">{h}</th>}</For><th><span class="visually-hidden">{t("common.delete")}</span></th></tr></thead>
              <tbody>
            {/* Index: a row keeps its element (and focus) while its marker moves */}
            <Index each={inspectionRows()}>{(row) => {
              const mark = () => row().marker.startsWith("M") ? userMarks().find(m => `M${m.id}` === row().marker) : undefined;
              return <tr tabindex={mark() ? 0 : undefined} classList={{ active: !!mark() && selectedId() === mark()!.id }} onFocus={() => { const m = mark(); if (m) setSelectedId(m.id); }}
                onKeyDown={(e) => {
                  const m = mark();
                  if (!m || e.target !== e.currentTarget) return;
                  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeMarker(m.id); }
                  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    e.preventDefault();
                    jumpMinimum(m.id, e.key === "ArrowLeft" ? -1 : 1);
                  }
                }}>
                <For each={cells(row())}>{(c) => <td title={c}>{c}</td>}</For>
                <td><Show when={mark()}><button type="button" class="btn btn-ghost btn-sm" aria-label={t("markers.deleteOne", { marker: row().marker })}
                  onClick={() => removeMarker(mark()!.id)}>×</button></Show></td>
              </tr>;
            }}</Index>
              </tbody>
            </table>
          </div></Show>
        </section>
      </Show>
    </div>
  );
}
