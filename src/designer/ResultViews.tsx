import { appModeRevision } from "../workspace";
import { openUserProject } from "../runner/openProject";
import { powerWaveReflection } from "../lib/powerWaves";
// The result views of the designer's main-area tabs (MainArea.tsx): S-parameters, impedance, VSWR,
// Smith chart, pattern cuts and a table of the shown run (designRun.ts designResult), and the toolbar
// over them (the shown run, Compare, the data format, Copy data, CSV, Touchstone). Several runs
// selected in the tree or the dock's Runs tab are compared (src/compare/series.ts), each trace named
// by its short run label (A, B, ...); the dock's Runs tab (RunDock.tsx) lists what the labels stand for.
import { createEffect, createMemo, createRoot, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Portal } from "solid-js/web";
import { Check, Copy, FileChartLine, FileSpreadsheet, GitCompareArrows, Globe, TriangleAlert, X } from "lucide-solid";
import LineChart, { type PointSeries, type Series } from "../charts/LineChart";
import StackedCharts from "../charts/StackedCharts";
import { useSize } from "../charts/useSize";
import { plotQuantities } from "../charts/plotQuantities";
import PolarChart from "../charts/PolarChart";
import SmithChart from "../charts/SmithChart";
import { DataTable } from "../components/Dock";
import { compareCuts, compareLines, compareSParamQuantities, compareTable, SERIES_COLORS, traces, traceLabels, type GroupedTable } from "../compare/series";
import { createSParamSelection, SParamSmithCompare, SParamTools } from "../components/SParamView";
import { cutPhi, setCutPhi, setZPart, zPart } from "../compare/store";
import { radioGroupKeys } from "../lib/a11y";
import { bandTexts } from "../lib/bands";
import { freqText, ghzText, num, withUnit } from "../lib/format";
import { nearestIndex, patternCut, sweep } from "../lib/rf";
import { pairLabel, sMatrix } from "../lib/sparams";
import { efficiencyIssue, efficiencyWarningUi } from "../lib/runText";
import { efficiencyData, effectiveQuantity, farfieldSummary, QUANTITY_LABEL, quantityGrid, quantityMax, toDb, type PortEfficiency } from "../lib/farfieldQuantity";
import { efficiencyUnit, patternQuantity, setEfficiencyUnit } from "../lib/patternQuantityStore";
import { lobeText, PatternQuantitySelect, quantityFallbackNote, totalEffText } from "../components/FarfieldCard";
import { downloadMessage, revealDownloadedFile, type DownloadResult } from "../lib/download";
import { isTerminal } from "../runner/api";
import { clearDesignResult, designJob, designResult } from "../runner/designRun";
import type { Bundle } from "../types";
import { resultFocus } from "./resultFocus";
import { MAX_COMPARE } from "./navModel";
import { comparedLoadState, comparisonReady, retryComparedRuns, comparedRuns, designRunBundle, designRuns, otherProjectRuns, ensureDesignRunBundles, loadRunBundle, runLabel, runShortLabel, selectedRuns, selectRun, showView } from "./runResults";
import { MAIN_TAB_LABELS, type MainResultView } from "./resultTabs";
import { copyResultData, exportResultCsv, resultDataTable, type ResultDataOptions } from "./resultData";
import { summaryMode, summaryReference } from "./summaryMode";
import { resultDataFormat, tableFormat, writeResultDataFormat, type ResultDataFormat } from "./resultDataPreference";
import { exportResultTouchstone } from "./resultTouchstone";
import { exportNotice, registerSurfaceExports } from "../components/exportContext";
import { saveVisibleFigure, visibleFigureSvgs } from "../components/visibleFigure";
import FieldMapView from "./FieldMapView";
import { ResultSummary } from "./RunSummaryView";
import { fmt, t } from "../i18n";
import "../styles/designer-sim.css";
import "../styles/result-views.css";

const COLORS = SERIES_COLORS;

/** The S-parameter picker state of the shown run (the same picker as the Examples dock). */
const designSParams = createRoot(() => createSParamSelection(() => {
  const r = designResult();
  return r ? sMatrix(r.bundle) : null;
}));

/** The focused run with the runs compared with it (null: no comparison), each labelled by its short
 * run label (A, B, ...), which the dock's Runs tab explains: legends stay short enough to read. */
function useCompare(b: () => Bundle) {
  return createMemo(() => {
    const others = comparedRuns();
    if (!others.length) return null;
    const current = designResult();
    const files = new Map<Bundle, string>(others.map((o) => [o.bundle, o.file]));
    if (current?.bundle === b()) files.set(b(), current.file);
    return traces(b(), others.map((o) => o.bundle), [current?.bundle === b() ? runLabel(current.file) : undefined, ...others.map((o) => runLabel(o.file))])
      .map((t) => { const file = files.get(t.bundle); return file ? { ...t, label: runShortLabel(file) } : t; });
  });
}

const minusSign = (s: string) => s.replace(/^-/, "−");
// a frequency axis in GHz: the tooltips and the marker table use the frequency format (LineChart)
const ghzAxis = { get xLabel() { return t("chart.frequencyGHz"); } };
const finite = (v: number) => (Number.isFinite(v) ? v : NaN);

function ResultSParams(props: { b: Bundle; format: ResultDataFormat }) {
  const S = createMemo(() => sMatrix(props.b));
  const sw = createMemo(() => sweep(props.b));
  const cmp = useCompare(() => props.b);
  // the S-parameter picker chooses the S_ij (and dB or phase), for the compared
  // runs too (each run in its colour, each picked pair with its own dash)
  // (a one-port design has the picker too, with S11 alone: the selection is never empty)
  const mp = () => (S()?.pairs.length ?? 0) >= 1;
  const groups = createMemo(() => {
    const c = cmp();
    if (c && (mp() || c.some((t) => sMatrix(t.bundle)?.get(1, 1)))) return compareSParamQuantities(c, mp() ? designSParams.selectedPairs() : [[1, 1]], props.format, designSParams.mode());
    if (c) {
      const inputs = c.flatMap((t, i) => { const m = sMatrix(t.bundle), v = m?.get(1, 1); return m && v ? [{ id: `cmp-${i}-1,1`, label: "S11", suffix: t.label, color: SERIES_COLORS[i], x: m.f.map(f => f / 1e9), re: v.re, im: v.im }] : []; });
      return plotQuantities(inputs, props.format, designSParams.mode());
    }
    const m = S();
    const inputs = mp() && m ? designSParams.selectedPairs().flatMap((p, k) => {
        const v = m.get(p[0], p[1]);
        return v ? [{ id: pairLabel(p), label: pairLabel(p), color: COLORS[k], x: m.f.map((f) => f / 1e9), re: v.re, im: v.im }] : [];
      }) : [];
    if (inputs.length) return plotQuantities(inputs, props.format, designSParams.mode());
    const s = sw();
    return s && (props.format === "plot" || props.format === "db") ? [{ key: "db", title: t("chart.q.magnitudeDb"), yLabel: "|S11| (dB)", kind: "reflection" as const, series: [{ id: "s11", label: "|S11|", color: COLORS[0], x: s.f.map((f) => f / 1e9), y: s.s11Db }] }] : [];
  });
  const bands = () => props.b.results?.bands ?? [];
  const extra = (i: number) => {
    const s = sw();
    const x = groups()[0]?.series[0]?.x[i];
    if (!s || x === undefined || cmp()) return [];
    const k = nearestIndex(s.f.map((f) => f / 1e9), x);
    return [{ label: "Zin", value: `${num(s.zRe[k], 1)} ${s.zIm[k] >= 0 ? "+" : "−"} j${num(Math.abs(s.zIm[k]), 1)} Ω` }];
  };
  const what = () => t(mp() ? (cmp() ? "results.aria.pickedSParamsCompared" : "results.aria.pickedSParams") : (cmp() ? "results.aria.inputReflectionCompared" : "results.aria.inputReflection"));
  return (
    <div class="rdk-split">
      <Show when={groups().some((g) => g.series.length)} fallback={<div class="panel-empty">{t("sparams.chooseOne")}</div>}>
        {/* one pane per quantity of the data format; the panes share the Markers button and the markers */}
        <StackedCharts groups={groups()} inspectionChart={`designer:${designResult()?.file ?? ""}:reflection`}
          ariaLabel={(g) => t("results.aria.vsFrequency", { title: g.title, what: what() })}
          pane={(g) => (g.key === "db" ? { bands: cmp() ? [] : bands().map((b) => ({ x0: b.f_lo / 1e9, x1: b.f_hi / 1e9 })), extra } : {})} />
      </Show>
      <Show when={!cmp()} fallback={<div class="rdk-side"><SpTools show={mp()} format={props.format} /></div>}>
        <div class="rdk-side"><SpTools show={mp()} format={props.format} /><dl class="kv">
          <Show when={bands().length} fallback={<><dt>{t("results.sparams.band10")}</dt><dd>{t("results.sparams.noBand")}</dd></>}>
            <For each={bands()}>{(b, i) => {
              // the band's edges, its centre (the middle of the edges) and its best match (the |S11| minimum)
              const c = bandTexts(b, (hz) => ghzText(hz / 1e9), fmt.fixed);
              return (
                <>
                  {/* the resonance is the band's best match (the |S11| minimum); its centre is the middle of the edges */}
                  <dt title={t("spec.bestMatch.title")}>{bands().length > 1 ? t("results.sparams.bandN", { n: i() + 1 }) : t("results.sparams.band")}</dt>
                  <dd class="mono">{withUnit(c.best, "GHz")}</dd>
                  <dt>|S11| min</dt><dd class="mono">{withUnit(minusSign(num(b.s11_min_db, 1)), "dB")}</dd>
                  <dt title={t("spec.centre.title")}>{t("spec.centre")}</dt><dd class="mono">{withUnit(c.centre, "GHz")}</dd>
                  <dt>{t("summary.range")}</dt><dd class="mono">{withUnit(c.range, "GHz")}</dd>
                  <dt>{t("results.sparams.bandwidth")}</dt><dd class="mono">{withUnit(c.bwMhz, "MHz")}<Show when={c.open}><span class="kv-sub">{t("spec.bandOpen")}</span></Show></dd>
                </>
              );
            }}</For>
          </Show>
          <dt>{t("results.sparams.points")}</dt><dd class="mono">{props.b.results?.frequency.length ?? 0}</dd>
        </dl></div>
      </Show>
    </div>
  );
}

/** The S-parameter picker (or, with `smith`, the Smith port) of the shown run, for a side panel. */
function SpTools(props: { show: boolean; smith?: boolean; format?: ResultDataFormat }) {
  return <Show when={props.show}><div class="rdk-sp-tools"><SParamTools store={designSParams} smith={props.smith} format={props.format} /></div></Show>;
}


function ResultImpedance(props: { b: Bundle }) {
  const reference = () => (props.b.ports.find((p) => p.excite) ?? props.b.ports[0])?.reference_impedance;
  const matching = createMemo(() => {
    const ref = reference(), s = sweep(props.b);
    if (!ref || !s || !s.f.length) return null;
    const k = Math.floor(s.f.length / 2);
    const power = powerWaveReflection(s.zRe[k], s.zIm[k], ref.real, ref.imag);
    return power ? { ...power, f: s.f[k], ref } : null;
  });
  const sw = createMemo(() => sweep(props.b));
  const cmp = useCompare(() => props.b);
  const series = createMemo<Series[]>(() => {
    const c = cmp();
    if (c) return compareLines(c, (s) => (zPart() === "re" ? s.zRe : s.zIm)).series;
    const s = sw();
    if (!s) return [];
    const x = s.f.map((f) => f / 1e9);
    return [{ id: "re", label: "Re Zin", color: COLORS[0], x, y: s.zRe }, { id: "im", label: "Im Zin", color: COLORS[1], x, y: s.zIm }];
  });
  return (
    <Show when={sw()} fallback={<div class="panel-empty">{t("results.noPortResult")}</div>}>
      <div class="rdk-split">
        <LineChart ariaLabel={cmp() ? t(zPart() === "re" ? "results.aria.zReCompared" : "results.aria.zImCompared") : t("results.aria.impedance")}
          inspection={{ key: `designer:${designResult()?.file ?? ""}:impedance:${zPart()}`, chart: `designer:${designResult()?.file ?? ""}:impedance`, kind: "other" }}
          series={series()} {...ghzAxis} yLabel={cmp() ? `${zPart() === "re" ? "Re" : "Im"} Zin (Ω)` : "Zin (Ω)"} yFormat={(v) => v.toFixed(1)}
          hlines={cmp() && zPart() === "im" ? [{ y: 0, label: "" }] : [{ y: sw()!.zRef, label: t("results.impedance.referenceLine", { z: num(sw()!.zRef, sw()!.zRef >= 100 ? 0 : 1) }) }, { y: 0, label: "" }]} />
        <Show when={cmp()} fallback={<div class="rdk-side"><dl class="kv"><dt>{t("results.impedance.reference")}</dt><dd class="mono">{num(sw()!.zRef, 1)} Ω</dd></dl><Show when={matching()}>{(m) => <><h3>{t("feed.complexReference")}</h3><dl class="kv"><dt>Zref</dt><dd class="mono">{m().ref.real} + j({m().ref.imag}) Ω</dd><dt>f</dt><dd class="mono">{num(m().f / 1e9, 4)} GHz</dd><dt>|Γ|</dt><dd class="mono">{num(m().magnitude, 4)}</dd><dt>{t("feed.transfer")}</dt><dd class="mono">{num(m().transfer * 100, 2)} %</dd></dl><p class="note">{t("feed.referenceNote")}</p></>}</Show></div>}>
          <div class="rdk-side">
            <div class="seg seg-sm" role="radiogroup" aria-label={t("results.impedance.part")} onKeyDown={radioGroupKeys}>
              <button class="seg-btn" role="radio" aria-checked={zPart() === "re"} onClick={() => setZPart("re")}>Re</button>
              <button class="seg-btn" role="radio" aria-checked={zPart() === "im"} onClick={() => setZPart("im")}>Im</button>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
}

function ResultVswr(props: { b: Bundle }) {
  const sw = createMemo(() => sweep(props.b));
  const cmp = useCompare(() => props.b);
  const series = createMemo<Series[]>(() => {
    const c = cmp();
    if (c) return compareLines(c, (s) => s.vswr.map(finite)).series;
    const s = sw();
    return s ? [{ id: "vswr", label: "VSWR", color: COLORS[0], x: s.f.map((f) => f / 1e9), y: s.vswr.map(finite) }] : [];
  });
  const best = () => {
    const s = sw();
    if (!s) return null;
    let k = 0;
    s.vswr.forEach((v, i) => { if (finite(v) < finite(s.vswr[k]) || !Number.isFinite(s.vswr[k])) k = i; });
    return { v: s.vswr[k], f: s.f[k] };
  };
  return (
    <Show when={sw()} fallback={<div class="panel-empty">{t("results.noPortResult")}</div>}>
      <div class="rdk-split">
        <LineChart ariaLabel={cmp() ? t("results.aria.vswrCompared") : t("results.aria.vswr")} series={series()} {...ghzAxis}
          inspection={{ key: `designer:${designResult()?.file ?? ""}:vswr`, kind: "other" }}
          yLabel="VSWR" yDomain={[1, 10]} hlines={[{ y: 2, label: "2:1" }]} yFormat={(v) => v.toFixed(1)} />
        <Show when={!cmp()}>
          <div class="rdk-side">
            <dl class="kv">
              <dt>{t("results.vswr.lowest")}</dt><dd class="mono">{best() && Number.isFinite(best()!.v) ? t("results.vswr.at", { v: num(best()!.v, 2), f: ghzText(best()!.f / 1e9) }) : "—"}</dd>
              <dt>{t("results.vswr.scale")}</dt><dd>{t("results.vswr.scaleRange")}</dd>
            </dl>
          </div>
        </Show>
      </div>
    </Show>
  );
}

function ResultSmith(props: { b: Bundle }) {
  const sw = createMemo(() => sweep(props.b));
  const cmp = useCompare(() => props.b);
  // two or more ports: the port picked beside the chart (S_pp of every compared run)
  const mp = () => (sMatrix(props.b)?.ports.length ?? 0) >= 2;
  const marks = () => (props.b.results?.farfield ?? []).map((f) => ({ f: f.f, label: freqText(f.f) }));
  const overlays = () => (cmp() ?? []).slice(1).map((t, i) => ({ label: t.label, color: COLORS[i + 1], re: t.sweep.s11Re, im: t.sweep.s11Im }));
  return (
    <Show when={sw()} fallback={<div class="panel-empty">{t("results.noPortResult")}</div>}>
      <div class={mp() ? "rdk-split" : "rdk-fill"}>
        <Show when={mp()} fallback={
          <SmithChart ariaLabel={t("results.aria.smith")} f={sw()!.f} re={sw()!.s11Re} im={sw()!.s11Im} zRe={sw()!.zRe} zIm={sw()!.zIm}
            zRef={sw()!.zRef} markers={marks()} label={cmp()?.[0]?.label} overlays={overlays()} />
        }>
          <SParamSmithCompare store={designSParams} traces={cmp() ?? [{ label: runLabel(designResult()?.file ?? ""), bundle: props.b, sweep: sw()! }]} markers={marks()} />
        </Show>
        <Show when={mp()}><div class="rdk-side"><SpTools show smith /></div></Show>
      </div>
    </Show>
  );
}

/** The Efficiency tab: the mismatch efficiency 1 − |S11|² over the band, and the radiation and total
 * efficiency (η_rad·(1 − |S11|²)) at the far-field frequencies, or over the band when the run stores
 * a band-wide radiation efficiency (results.efficiency). One colour per quantity for a single driven
 * port; per port (dashes for the quantity) for multi-port runs; per run when runs are compared. */
function ResultEfficiency(props: { b: Bundle }) {
  const cmp = useCompare(() => props.b);
  const data = createMemo(() => efficiencyData(props.b));
  const db = () => efficiencyUnit() === "db";
  const val = (eta: number | null) => (eta === null || !Number.isFinite(eta) ? Number.NaN : db() ? toDb(eta) : eta * 100);
  const ghz = (f: number[]) => f.map((x) => x / 1e9);
  const multi = () => data().length > 1;
  const portTag = (d: PortEfficiency) => (multi() && d.port != null ? ` · P${d.port}` : "");
  const tr = t; // in the comparison below `t` names a trace
  const plot = createMemo<{ series: Series[]; points: PointSeries[] }>(() => {
    const c = cmp();
    if (c) {
      const lines = compareLines(c, (s) => s.s11Re.map((re, i) => val(1 - re * re - s.s11Im[i] * s.s11Im[i]))).series;
      const points = c.flatMap((t, i): PointSeries[] => {
        const pts = efficiencyData(t.bundle)[0]?.points.filter((p) => p.total !== null) ?? [];
        return pts.length ? [{ id: `cmp-${i}-total`, label: `${tr("efficiency.total")} · ${t.label}`, color: SERIES_COLORS[i], shape: "diamond", x: pts.map((p) => p.f / 1e9), y: pts.map((p) => val(p.total)), warn: pts.map((p) => p.warning) }] : [];
      });
      return { series: lines, points };
    }
    const series: Series[] = [];
    const points: PointSeries[] = [];
    data().forEach((d, k) => {
      const color = (q: number) => COLORS[multi() ? k % COLORS.length : q];
      const dash = (q: number) => (multi() ? [undefined, "6 4", "2 3"][q] : undefined);
      if (d.mismatch) series.push({ id: `mis-${k}`, label: `${t("efficiency.mismatch")}${portTag(d)}`, color: color(0), dash: dash(0), x: ghz(d.mismatch.f), y: d.mismatch.eta.map(val) });
      if (d.band) {
        series.push({ id: `rad-${k}`, label: `${t("efficiency.radiation")}${portTag(d)}`, color: color(1), dash: dash(1), x: ghz(d.band.f), y: d.band.rad.map(val) });
        series.push({ id: `tot-${k}`, label: `${t("efficiency.total")}${portTag(d)}`, color: color(2), dash: dash(2), x: ghz(d.band.f), y: d.band.total.map(val) });
        // values the run marks unreliable: a gap in the curves, drawn as flagged points instead
        const u = d.band.unreliable;
        const why = u.f.map(() => t("efficiency.unreliableWhy"));
        if (u.f.length) points.push({ id: `rad-bad-${k}`, label: `${t("efficiency.radiationUnreliable")}${portTag(d)}`, color: color(1), shape: "circle", x: ghz(u.f), y: u.rad.map(val), warn: why });
      }
      const rad = d.points.filter((p) => p.rad !== null);
      const tot = d.points.filter((p) => p.total !== null);
      const at = d.band ? ` (${t("efficiency.farFieldTag")})` : "";
      if (rad.length) points.push({ id: `rad-pt-${k}`, label: `${t("efficiency.radiation")}${at}${portTag(d)}`, color: color(1), shape: "circle", x: rad.map((p) => p.f / 1e9), y: rad.map((p) => val(p.rad)), warn: rad.map((p) => p.warning) });
      if (tot.length) points.push({ id: `tot-pt-${k}`, label: `${t("efficiency.total")}${at}${portTag(d)}`, color: color(2), shape: "diamond", x: tot.map((p) => p.f / 1e9), y: tot.map((p) => val(p.total)), warn: tot.map((p) => p.warning) });
    });
    return { series, points };
  });
  const yDomain = (): [number, number] => {
    const ys = [...plot().series.flatMap((s) => s.y), ...plot().points.flatMap((p) => p.y)].filter(Number.isFinite);
    const hi = Math.max(...ys, db() ? 0 : 100);
    const lo = ys.length ? Math.min(...ys) : 0;
    // % from the lowest value (in tens, 0 at the least) to 100 % or above: a well-matched antenna is not
    // squeezed into the top of a 0–100 % axis
    return db() ? [Math.max(-30, Math.floor(lo / 5) * 5), Math.max(1, Math.ceil(hi))] : [Math.max(0, Math.floor((lo - 5) / 10) * 10), Math.max(100, Math.ceil(hi / 5) * 5)];
  };
  const band = () => data().find((d) => d.band)?.band ?? null;
  const pointCount = () => new Set(data().flatMap((d) => d.points.map((p) => p.f))).size;
  const overUnity = () => data().reduce((n, d) => n + (d.band?.warnings ?? 0) + d.points.filter((p) => p.warning).length, 0);
  const unreliable = () => data().reduce((n, d) => n + (d.band?.unreliable.f.length ?? 0), 0);
  /** the exporter's notes on the band-wide efficiency (results.efficiency[].qa_warnings) */
  const qaNotes = () => [...new Set(data().flatMap((d) => d.band?.qa ?? []))];
  const effText = (eta: number | null) => (eta === null ? "—" : db() ? withUnit(minusSign(num(toDb(eta), 2)), "dB") : t("format.percent", { value: num(eta * 100, 1) }));
  /** the worst value above 100 % (band and far-field points) and where */
  const worst = createMemo(() => {
    let best: { eta: number; f: number } | null = null;
    for (const d of data()) {
      d.band?.rad.forEach((eta, i) => { if (eta > 1 && (!best || eta > best.eta)) best = { eta, f: d.band!.f[i] }; });
      for (const p of d.points) if (p.warning && p.rad !== null && (!best || p.rad > best.eta)) best = { eta: p.rad, f: p.f };
    }
    return best as { eta: number; f: number } | null;
  });
  /** the card's one line: what is wrong (values above 100 %, unreliable values), or nothing */
  const issueLine = () => [
    overUnity() && worst() ? t("efficiency.overUnityLine", { count: overUnity(), eta: num(worst()!.eta * 100, 1), f: ghzText(worst()!.f / 1e9) }) : "",
    unreliable() ? t("efficiency.unreliableLine", { count: unreliable() }) : "",
  ].filter(Boolean).join(" · ");
  const basicNote = () => (band() ? t("efficiency.noteBand", { count: band()!.f.length }) : t("efficiency.noteFarfieldOnly", { n: pointCount() || t("efficiency.none") }));
  return (
    <Show when={data().some((d) => d.mismatch)} fallback={<div class="panel-empty">{t("results.noPortResult")}</div>}>
      <div class="rdk-split">
        <LineChart ariaLabel={cmp() ? t("efficiency.ariaCompared") : t("efficiency.aria")}
          inspection={{ key: `designer:${designResult()?.file ?? ""}:efficiency:${efficiencyUnit()}`, chart: `designer:${designResult()?.file ?? ""}:efficiency`, kind: "other" }}
          series={plot().series} points={plot().points} {...ghzAxis} yLabel={db() ? t("efficiency.axisDb") : t("efficiency.axisPct")} yDomain={yDomain()}
          yFormat={(v) => v.toFixed(db() ? 2 : 1)}
          hlines={db() ? [{ y: 0, label: "0 dB" }, { y: toDb(0.9), label: "|S11| = −10 dB" }] : [{ y: 100, label: t("format.percent", { value: 100 }) }, { y: 90, label: "|S11| = −10 dB" }]} />
        <div class="rdk-side">
          <div class="seg seg-sm" role="radiogroup" aria-label={t("efficiency.unit")} onKeyDown={radioGroupKeys}>
            <button class="seg-btn" role="radio" aria-checked={!db()} tabindex={db() ? -1 : 0} onClick={() => setEfficiencyUnit("pct")}>%</button>
            <button class="seg-btn" role="radio" aria-checked={db()} tabindex={db() ? 0 : -1} onClick={() => setEfficiencyUnit("db")}>dB</button>
          </div>
          <Show when={!cmp()}>
            <For each={data().filter((d) => d.points.length)}>{(d) => (
              <dl class="kv">
                <For each={d.points}>{(p) => (
                  <>
                    <dt class="rdk-kv-head">{freqText(p.f)}{portTag(d)}</dt><dd />
                    <dt>{t("efficiency.radiation")}</dt>
                    <dd class="mono" classList={{ "cell-warn": !!p.warning }} title={p.warning ?? undefined}>
                      {effText(p.rad)}<Show when={p.warning}> <TriangleAlert size={12} aria-label={t("efficiency.overUnityShort")} /></Show>
                    </dd>
                    <dt>{t("efficiency.mismatch")}</dt><dd class="mono">{effText(p.mismatch)}</dd>
                    <dt>{t("efficiency.total")}</dt><dd class="mono" classList={{ "cell-warn": !!p.warning }}>{effText(p.total)}</dd>
                  </>
                )}</For>
              </dl>
            )}</For>
          </Show>
          {/* one line (the warning when there is one, else what the curves are) and the rest under Details */}
          <Show when={issueLine()} fallback={<p class="rdk-note" role="note">{basicNote()}</p>}>
            <p class="rdk-note cell-warn" role="note"><TriangleAlert size={12} aria-hidden="true" /> {issueLine()}</p>
          </Show>
          <details class="rdk-details">
            <summary>{t("efficiency.details")}</summary>
            <Show when={issueLine()}><p class="rdk-note">{basicNote()}</p></Show>
            <p class="rdk-note">{t("efficiency.noteTotal")}<Show when={cmp()}> {t("efficiency.noteCompared")}</Show></p>
            <Show when={overUnity()}><p class="rdk-note">{t("efficiency.overUnityNote", { count: overUnity() })}</p></Show>
            <Show when={unreliable()}><p class="rdk-note">{t("efficiency.unreliableNote", { count: unreliable() })}</p></Show>
            <For each={qaNotes()}>{(note) => <p class="rdk-note">{note}</p>}</For>
          </details>
        </div>
      </div>
    </Show>
  );
}

/** Chips for the far-field frequencies of the Pattern tab; a chip focuses that frequency. */
function FreqChips(props: { label: string; freqs: number[]; active: number | undefined }) {
  return (
    <Show when={props.freqs.length > 1}>
      <div class="freq-chips" role="radiogroup" aria-label={props.label} onKeyDown={radioGroupKeys}>
        <For each={props.freqs}>{(f) => (
          <button role="radio" aria-checked={props.active === f} class="chip-btn" classList={{ active: props.active === f }} onClick={() => showView("pattern", f, "main")}>
            {ghzText(f / 1e9)}
          </button>
        )}</For>
      </div>
    </Show>
  );
}

function ResultPattern(props: { b: Bundle }) {
  const ffs = () => props.b.results?.farfield ?? [];
  const k = () => {
    const f = resultFocus()?.f;
    return f === undefined || !ffs().length ? 0 : nearestIndex(ffs().map((x) => x.f), f);
  };
  const ff = () => ffs()[Math.min(k(), ffs().length - 1)];
  const cmp = useCompare(() => props.b);
  const qLabel = () => QUANTITY_LABEL[ff() ? effectiveQuantity(props.b, ff()!, patternQuantity()) : "directivity"];
  const summary = createMemo(() => (ff() ? farfieldSummary(props.b, ff()!) : null));
  const cuts = () => {
    const f = ff();
    if (!f) return [];
    const c = cmp();
    const q = patternQuantity();
    if (c) return compareCuts(c, f.f, cutPhi(), f, (b, x) => quantityGrid(b, x, q));
    const half = !!props.b.half_space;
    const grid = quantityGrid(props.b, f, q);
    const a = patternCut(f.theta, f.phi, grid, 0, half);
    const b = patternCut(f.theta, f.phi, grid, 90, half);
    return [
      { id: "phi0", label: "φ = 0° (xz)", color: COLORS[0], angle: a.angle, value: a.value },
      { id: "phi90", label: "φ = 90° (yz)", color: COLORS[1], angle: b.angle, value: b.value },
    ];
  };
  return (
    <Show when={ff()} fallback={<div class="panel-empty">{t("results.pattern.none")}</div>}>
      <div class="rdk-split">
        <PolarChart ariaLabel={cmp() ? t("results.pattern.cutCompared", { quantity: qLabel(), phi: cutPhi() }) : t("results.pattern.cuts", { quantity: qLabel() })} series={cuts()} directLabels={!!cmp()}
          half={!!props.b.half_space} unit="dBi" range={30}
          max={Math.ceil(Math.max(quantityMax(props.b, ff()!, patternQuantity()), ...cuts().flatMap((c) => c.value).filter(Number.isFinite)))} />
        <div class="rdk-side">
          <FreqChips label={t("farfield.frequency")} freqs={[...new Set(ffs().map((f) => f.f))]} active={ff()!.f} />
          <label class="rdk-field"><span>{t("results.pattern.quantity")}</span><PatternQuantitySelect bundle={props.b} ff={ff()!} /></label>
          <Show when={quantityFallbackNote(props.b, ff()!, patternQuantity())}>{(note) => <p class="rdk-note" role="note">{note()}</p>}</Show>
          <Show when={cmp()}>
            <div class="seg seg-sm" role="radiogroup" aria-label={t("results.pattern.cut")} onKeyDown={radioGroupKeys}>
              <button class="seg-btn" role="radio" aria-checked={cutPhi() === 0} onClick={() => setCutPhi(0)}>φ 0°</button>
              <button class="seg-btn" role="radio" aria-checked={cutPhi() === 90} onClick={() => setCutPhi(90)}>φ 90°</button>
            </div>
          </Show>
          <dl class="kv">
            <dt>{t("results.pattern.frequency")}</dt><dd class="mono">{freqText(ff()!.f)}</dd>
            <dt>Dmax</dt><dd class="mono">{withUnit(num(ff()!.dmax_dbi, 2), "dBi")}</dd>
            <dt>{t("farfield.quantity.gain")}</dt><dd class="mono">{ff()!.gain_dbi !== undefined ? withUnit(num(ff()!.gain_dbi, 2), "dBi") : "—"}</dd>
            <dt>{t("farfield.quantity.realized")}</dt><dd class="mono">{ff()!.realized_gain_dbi !== undefined ? withUnit(num(ff()!.realized_gain_dbi, 2), "dBi") : "—"}</dd>
            <dt>{t("farfield.radEff")}</dt>
            <dd class="mono" classList={{ "cell-warn": !!efficiencyIssue(ff()!) }} title={efficiencyWarningUi(ff()!) ?? undefined}>{ff()!.rad_efficiency !== null ? t("format.percent", { value: num(ff()!.rad_efficiency! * 100, 1) }) : "—"}</dd>
            <dt title={t("farfield.totalTitlePort")}>{t("farfield.total")}</dt>
            <dd class="mono">{summary()?.totalEff != null ? totalEffText(summary()!.totalEff!) : "—"}</dd>
            <dt title={t("farfield.lobeTitle")}>{t("farfield.mainLobe")}</dt><dd class="mono">{summary() ? lobeText(summary()!.peak) : "—"}</dd>
            <Show when={new Set(ffs().map((f) => f.port)).size > 1}><dt>{t("farfield.drivenPort")}</dt><dd class="mono">P{summary()?.port ?? "?"}</dd></Show>
            <dt>θ = 0°</dt><dd>+z</dd>
          </dl>
        </div>
      </div>
    </Show>
  );
}

const everyRow = (n: number, maxRows = 201) => {
  const step = Math.max(1, Math.ceil(n / maxRows));
  return [...Array(n).keys()].filter((i) => i % step === 0 || i === n - 1);
};

function ResultTable(props: { b: Bundle }) {
  const cmp = useCompare(() => props.b);
  const data = createMemo<GroupedTable | null>(() => {
    const c = cmp();
    if (c) {
      const s11 = compareLines(c, (s) => s.s11Db);
      const vswr = compareLines(c, (s) => s.vswr.map(finite));
      return compareTable("f (GHz)", s11.x, c, [
        { label: "|S11| (dB)", values: (i) => s11.series[i].y },
        { label: "VSWR", values: (i) => vswr.series[i].y },
      ]);
    }
    const s = sweep(props.b);
    if (!s) return null;
    return {
      columns: ["f (GHz)", "|S11| (dB)", "VSWR", "Re Zin (Ω)", "Im Zin (Ω)"],
      rows: everyRow(s.f.length).map((i) => [s.f[i] / 1e9, s.s11Db[i], Number.isFinite(s.vswr[i]) ? s.vswr[i] : "∞", s.zRe[i], s.zIm[i]]),
    };
  });
  return (
    <Show when={data()} fallback={<div class="panel-empty">{t("results.noPortResult")}</div>}>{(d) => (
      <DataTable data={d()} />
    )}</Show>
  );
}

/** One result view of the shown run: MainArea.tsx fills a main-area tab with it. */
export function ResultBody(props: { view: MainResultView; b: Bundle; format: ResultDataFormat }) {
  return (
    <Switch>
      <Match when={props.view === "sparams"}><ResultSParams b={props.b} format={props.format} /></Match>
      <Match when={props.view === "impedance"}><ResultImpedance b={props.b} /></Match>
      <Match when={props.view === "vswr"}><ResultVswr b={props.b} /></Match>
      <Match when={props.view === "smith"}><ResultSmith b={props.b} /></Match>
      <Match when={props.view === "efficiency"}><ResultEfficiency b={props.b} /></Match>
      <Match when={props.view === "pattern"}><ResultPattern b={props.b} /></Match>
      <Match when={props.view === "table"}><ResultTable b={props.b} /></Match>
      <Match when={props.view === "summary"}><ResultSummary b={props.b} /></Match>
      <Match when={props.view === "fieldmap"}><FieldMapView b={props.b} /></Match>
    </Switch>
  );
}

// ------------------------------------------------------------------ the result toolbar

/** The toolbar row at the top of a result tab: the shown run(s), the Compare picker, the pattern in
 * 3D (Pattern tab), the data format, Copy data (also Ctrl/⌘+C in the tab), CSV, Touchstone, and the
 * close button of the shown run. */
export function ResultToolbar(props: { view: MainResultView }) {
  let bar!: HTMLDivElement;
  const barSize = useSize(() => bar); // a narrow bar folds its labelled buttons to icons
  const [dataAction, setDataAction] = createSignal("");
  // the feedback line: a failure (warning icon and colour), or a saved file (Show in folder)
  const [problem, setProblem] = createSignal(false);
  const [savedPath, setSavedPath] = createSignal<string | null>(null);
  const [openingResult, setOpeningResult] = createSignal<string | null>(null);
  const [failedResult, setFailedResult] = createSignal<string | null>(null);
  const openForeignResult = async (file: string) => {
    const revision = appModeRevision();
    setOpeningResult(file); setFailedResult(null);
    const opened = await openUserProject(file);
    setOpeningResult(null);
    if (opened) closeCompare(); else if (appModeRevision() === revision) setFailedResult(file);
  };
  const [compareOpen, setCompareOpen] = createSignal(false);
  let compareTrigger!: HTMLButtonElement, comparePopover!: HTMLDivElement;
  const [comparePosition, setComparePosition] = createSignal({ left: 8, top: 8 });
  const closeCompare = (restoreFocus = false) => {
    setCompareOpen(false);
    if (restoreFocus) compareTrigger?.focus({ preventScroll: true });
  };
  const toggleComparePicker = () => {
    if (compareOpen()) { closeCompare(); return; }
    const anchor = compareTrigger.getBoundingClientRect();
    setComparePosition({ left: Math.max(8, anchor.right - 320), top: anchor.bottom + 4 });
    setCompareOpen(true);
    queueMicrotask(() => {
      if (!compareOpen()) return;
      const box = comparePopover.getBoundingClientRect();
      setComparePosition({ left: Math.max(8, Math.min(box.left, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(box.top, window.innerHeight - box.height - 8)) });
      comparePopover.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    });
  };
  onMount(() => {
    const outside = (event: PointerEvent) => {
      if (compareOpen() && !comparePopover.contains(event.target as Node) && !compareTrigger.contains(event.target as Node)) closeCompare();
    };
    const resize = () => closeCompare();
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', resize);
    onCleanup(() => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', resize); });
  });
  // the picker names runs by their differing parameters: the bundles are read when it opens
  createEffect(() => { if (compareOpen()) ensureDesignRunBundles(); });
  const pickerLabels = createMemo<Record<string, string>>(() => {
    const good = designRuns().flatMap((r) => { const bundle = designRunBundle(r.file); return bundle ? [{ file: r.file, bundle }] : []; });
    const names = traceLabels(good.map((x) => x.bundle), good.map((x) => runLabel(x.file)));
    return Object.fromEntries(good.map((x, i) => [x.file, `${runShortLabel(x.file)} · ${names[i]}`]));
  });
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  // the Copy data button itself says "Copied" for a moment; failures go to the feedback line
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const flashCopied = () => { clearTimeout(copiedTimer); setCopied(true); copiedTimer = setTimeout(() => setCopied(false), 1600); };
  // a saved file's "Saved to … · Show in folder" stays long enough to click
  const feedback = (message: string, ms = 3500, failed = false, path: string | null = null) => {
    clearTimeout(feedbackTimer);
    exportNotice(message);
    setDataAction(message); setProblem(failed); setSavedPath(path);
    feedbackTimer = setTimeout(() => { setDataAction(""); setProblem(false); setSavedPath(null); }, ms);
  };
  const saved = (result: DownloadResult) => {
    if (result.status === "saved" && result.path) feedback(t("results.toolbar.savedTo", { path: result.path }), 30_000, false, result.path);
    else feedback(downloadMessage(result), 3500, result.status === "failed" || result.status === "cancelled");
  };
  const toggleCompare = (file: string) => { if (!selectRun(file, true, "main")) feedback(t("results.toolbar.compareLimit", { count: MAX_COMPARE }), 3500, true); };
  onCleanup(() => { clearTimeout(feedbackTimer); clearTimeout(copiedTimer); });
  // Copy data and CSV follow the plot (the picked S_ij, dB or phase, the Smith port) and name
  // compared runs by their full run labels
  const dataOptions = (runs?: { file: string }[]): ResultDataOptions => ({
    format: tableFormat(resultDataFormat()),
    ...((designSParams.S()?.ports.length ?? 0) >= 2
      ? { pairs: designSParams.selectedPairs(), sparamMode: designSParams.mode(), smithPort: designSParams.smithPort() }
      : {}),
    runNames: runs?.map((r) => runLabel(r.file)),
    patternQuantity: patternQuantity(),
    fieldPlane: resultFocus()?.map,
    summaryDeltas: summaryMode() === "delta",
    summaryReference: summaryReference(),
  });
  const comparedBundles = async (run: { file: string; bundle: Bundle }) => {
    const files = selectedRuns();
    if (resultFocus() && resultFocus()?.file !== run.file) throw new Error(t("results.compare.changed"));
    // the summary lists its runs, one included (its rows carry the file name)
    if (files.length < 2) return props.view === "summary" ? [{ file: run.file, bundle: run.bundle }] : undefined;
    const loaded = await Promise.all(files.map(async (file) => ({ file, bundle: file === run.file ? run.bundle : await loadRunBundle(file) })));
    if (designResult()?.file !== run.file || designResult()?.bundle !== run.bundle || (resultFocus() && resultFocus()?.file !== run.file) || selectedRuns().join("\n") !== files.join("\n")) throw new Error(t("results.compare.changed"));
    return loaded;
  };
  const baseName = (file: string) => file.split(/[\\/]/).pop()!.replace(/\.json$/i, "");
  const copyData = async () => {
    const run = designResult();
    if (!run) return;
    try {
      const frequency = resultFocus()?.f, options = dataOptions(selectedRuns().map(file => ({ file })));
      const runs = await comparedBundles(run);
      const result = await copyResultData(run.bundle, props.view, frequency, runs, options);
      if (result.ok) flashCopied(); else feedback(t("results.toolbar.copyFailed", { error: result.message }), 3500, true);
    } catch (error) { feedback(t("results.toolbar.copyFailed", { error: error instanceof Error ? error.message : String(error) }), 3500, true); }
  };
  const exportData = async () => {
    const run = designResult();
    if (!run) return;
    try {
      const frequency = resultFocus()?.f, options = dataOptions(selectedRuns().map(file => ({ file })));
      const runs = await comparedBundles(run);
      saved(await exportResultCsv(run.bundle, props.view, `${baseName(run.file)}-${props.view}.csv`, frequency, runs, options));
    } catch (error) { feedback(error instanceof Error ? error.message : t("results.toolbar.exportFailed"), 3500, true); }
  };
  const exportTouchstone = async () => {
    const run = designResult();
    if (!run?.bundle.results) return;
    try {
      const runs = await comparedBundles(run);
      saved(await exportResultTouchstone(run.bundle, baseName(run.file), runs));
    } catch (error) { feedback(t("results.toolbar.touchstoneFailed", { error: error instanceof Error ? error.message : String(error) }), 3500, true); }
  };
  onMount(()=> {
    const plot=()=>bar.closest(".dw-result")?.querySelector<HTMLElement>(".dw-result-plot")??null;
    const ready=()=>!!designResult()?.bundle.results && (!resultFocus() || resultFocus()?.file===designResult()?.file);
    const chart=()=>ready() && comparisonReady() && visibleFigureSvgs(plot()).length>0;
    const figure=(format:"png"|"svg")=>saveVisibleFigure(plot(),`${baseName(designResult()?.file??"result")}-${props.view}`,format);
    onCleanup(registerSurfaceExports("design-result",{ready:chart,screenshot:()=>figure("png"),actions:()=>[
      {id:"result-csv",label:t("contextExport.resultCsv"),disabled:!ready()||!resultDataTable(designResult()?.bundle,props.view,resultFocus()?.f,dataOptions()).rows.length,reason:t("contextExport.noData"),run:exportData},
      {id:"result-touchstone",label:t("contextExport.touchstone"),disabled:!ready()||!sMatrix(designResult()!.bundle)?.pairs.length,reason:t("contextExport.noSParameters"),run:exportTouchstone},
      ...(["svg","png"] as const).map(format=>({id:`figure-${format}`,label:t("contextExport.figureFormat",{format:format.toUpperCase()}),disabled:!chart(),reason:t("contextExport.noChart"),run:()=>figure(format)})),
    ]}));
  });
  // Ctrl/⌘+C anywhere in the result tab copies its data (not while text is selected or typed)
  onMount(() => {
    const panel = bar.closest<HTMLElement>(".dw-result");
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "c" || !designResult()) return;
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']") || window.getSelection()?.toString()) return;
      e.preventDefault();
      void copyData();
    };
    panel?.addEventListener("keydown", onKey);
    onCleanup(() => panel?.removeEventListener("keydown", onKey));
  });
  const running = () => !!designJob() && !isTerminal(designJob()!.status);
  const shown = () => {
    const r = designResult();
    if (!r) return "";
    const others = resultFocus()?.compare?.length ?? 0;
    const name = `${runShortLabel(r.file)} · ${runLabel(r.file)}`;
    return others ? `${name} +${others}` : name;
  };
  const farfields = () => designResult()?.bundle.results?.farfield ?? [];
  // the Touchstone file of the shown run: .s1p, .s2p, …
  const touchstoneExt = () => `.s${Math.max(1, sMatrix(designResult()?.bundle)?.ports.length ?? 1)}p`;
  return (
    <div class="dw-result-bar" classList={{ "is-narrow": barSize().w > 0 && barSize().w < 1000 }} ref={bar} role="toolbar" aria-label={t("results.toolbar.aria", { tab: MAIN_TAB_LABELS[props.view] })}>
      <span class="dock-hint rdk-shown" title={designResult()?.file}>{shown()}</span>
      {/* a field map belongs to one run: no comparison, and no S-parameter data format */}
      <Show when={props.view !== "fieldmap"}>
      <div class="rdk-compare-control">
        <button ref={compareTrigger} class="btn btn-ghost btn-sm" aria-haspopup="dialog" aria-expanded={compareOpen()} aria-controls="rdk-compare-popover" aria-label={t("results.toolbar.compare")} onClick={toggleComparePicker}>
          <GitCompareArrows size={14} aria-hidden="true" /> <span class="btn-label">{t("results.toolbar.compare")}</span>
        </button>
        <Show when={compareOpen()}>
          <Portal><div ref={comparePopover} id="rdk-compare-popover" class="rdk-compare-popover" role="dialog" aria-label={t("results.toolbar.compareRuns")}
            style={{ left: `${comparePosition().left}px`, top: `${comparePosition().top}px` }}
            onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCompare(true); } }}>
            <strong>{t("results.toolbar.compareRuns")}</strong><span class="muted">{t("results.toolbar.compareHint", { count: MAX_COMPARE })}</span>
            <strong>{t("results.compare.currentProject")}</strong>
            <For each={designRuns()}>{(run) => (
              <label title={runLabel(run.file)}>
                <input type="checkbox" checked={selectedRuns().includes(run.file)} onChange={(event) => {
                  toggleCompare(run.file);
                  // A rejected run or the final selected run does not change the signal; restore the
                  // native checkbox to the actual selection as well.
                  event.currentTarget.checked = selectedRuns().includes(run.file);
                }} />
                {pickerLabels()[run.file] ?? `${runShortLabel(run.file)} · ${run.label}`}
              </label>
            )}</For>
            <Show when={otherProjectRuns().length}>
              <strong>{t("results.compare.otherProjects")}</strong>
              <span class="muted">{t("results.compare.overlayHint")}</span>
              <span class="muted">{t("results.compare.openResultHint")}</span>
              <Show when={openingResult()}><span role="status">{t("results.compare.loading")}</span></Show>
              <Show when={failedResult()}><span role="alert">{t("results.compare.openResultFailed")}</span></Show>
              <For each={otherProjectRuns()}>{run => (
                <div style={{ display: "flex", "align-items": "center", gap: "4px" }}>
                <label title={runLabel(run.file)} style={{ flex: "1", "min-width": "0" }}>
                  <input type="checkbox" data-compare-overlay={run.file} checked={selectedRuns().includes(run.file)} onChange={event => {
                    toggleCompare(run.file);
                    event.currentTarget.checked = selectedRuns().includes(run.file);
                  }}/>
                  <span style={{ "overflow-wrap": "anywhere" }}>{runLabel(run.file)}</span>
                </label>
                  <button class="btn btn-ghost btn-sm" data-open-result={run.file} disabled={!!openingResult()} title={t("results.compare.openResultTitle", { run: runLabel(run.file) })} onClick={() => void openForeignResult(run.file)}>{t(failedResult() === run.file ? "results.compare.retry" : "results.compare.openResult")}</button>
                </div>
              )}</For>
            </Show>
            <For each={Object.entries(comparedLoadState())}>{([file, state]) => (
              <div data-compare-state={state} title={file} role="status">
                <span>{runLabel(file)} · {t(state === "loading" ? "results.compare.loading" : "results.compare.failed")}</span>
                <Show when={state === "error"}><button class="btn btn-ghost btn-sm" onClick={retryComparedRuns}>{t("results.compare.retry")}</button><button class="btn btn-ghost btn-sm" onClick={() => toggleCompare(file)}>{t("results.compare.remove")}</button></Show>
              </div>
            )}</For>
          </div></Portal>
        </Show>
        <Show when={!comparisonReady()}><span class="muted" role="status">{t(Object.values(comparedLoadState()).includes("error") ? "results.compare.failed" : "results.compare.loading")}</span></Show>
      </div>
      </Show>
      <Show when={props.view === "pattern" && farfields().length}>
        <button class="btn btn-ghost btn-sm" type="button" title={t("results.toolbar.show3dTitle")}
          onClick={() => showView("pattern3d", resultFocus()?.f ?? farfields()[0].f)}>
          <Globe size={14} aria-hidden="true" /> {t("results.toolbar.show3d")}
        </button>
      </Show>
      <Show when={props.view !== "summary" && props.view !== "fieldmap"}>
      <select class="btn btn-ghost btn-sm result-format" aria-label={t("results.toolbar.formatAria")} value={resultDataFormat()} onChange={(event) => writeResultDataFormat(event.currentTarget.value as ResultDataFormat)}>
        <option value="plot">{t("results.format.plot")}</option><option value="db">dB</option><option value="db_phase">{t("results.format.dbPhase")}</option><option value="re_im">Re/Im</option><option value="mag_phase">{t("results.format.magPhase")}</option><option value="all">{t("results.format.all")}</option>
      </select>
      </Show>
      <button class="btn btn-ghost btn-sm rdk-copy" classList={{ copied: copied() }} onClick={() => void copyData()} title={t("results.toolbar.copyDataTitle")} aria-live="polite">
        <Show when={copied()} fallback={<><Copy size={14} aria-hidden="true" /> {t("results.toolbar.copyData")}</>}><Check size={14} aria-hidden="true" /> {t("results.toolbar.copied")}</Show>
      </button>
      {/* CSV and Touchstone: their own icons and a short label that stays when the bar folds to icons */}
      <button class="btn btn-ghost btn-sm" onClick={exportData} title={t("results.toolbar.csvTitle")} aria-label={t("results.toolbar.csvTitle")}><FileSpreadsheet size={14} aria-hidden="true" /> <span class="btn-short">CSV</span></button>
      <Show when={designResult()?.bundle.results && props.view !== "summary"}>
        <button class="btn btn-ghost btn-sm" onClick={exportTouchstone} title={t("results.toolbar.touchstoneTitle")} aria-label={t("results.toolbar.touchstoneTitle")}>
          <FileChartLine size={14} aria-hidden="true" /> <span class="btn-short">{touchstoneExt()}</span>
        </button>
      </Show>
      <Show when={dataAction()}>
        {/* Neutral feedback; failures use the warning icon and colour. */}
        <span class="rdk-action-feedback" classList={{ "is-problem": problem() }} role="status" aria-live="polite">
          <Show when={problem()}><TriangleAlert size={12} aria-hidden="true" /></Show>
          {dataAction()}
          <Show when={savedPath()}>{(path) => (
            <button class="linklike" onClick={() => void revealDownloadedFile(path())
              .catch((error) => feedback(t("results.toolbar.showInFolderFailed", { error: String(error) }), 3500, true))}>{t("results.toolbar.showInFolder")}</button>
          )}</Show>
        </span>
      </Show>
      <Show when={!running()}>
        <button class="icon-btn icon-btn-sm dw-result-close" onClick={clearDesignResult} aria-label={t("results.toolbar.closeRun")} title={t("results.toolbar.closeRunTitle")}><X size={13} /></button>
      </Show>
    </div>
  );
}
