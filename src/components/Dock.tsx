import DockResizeHandle from "./DockResizeHandle";
import { createEffect, createMemo, createSignal, For, type JSX, lazy, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { Check, Copy, FileChartLine, FileSpreadsheet, Table2, TriangleAlert } from "lucide-solid";
import LineChart, { type Series } from "../charts/LineChart";
import StackedCharts from "../charts/StackedCharts";
import { quantityDomain, quantityLines } from "../charts/quantityAxes";
import { useSize } from "../charts/useSize";
import PolarChart from "../charts/PolarChart";
import SmithChart from "../charts/SmithChart";
import FigureMenu from "./FigureMenu";
import { radioGroupKeys } from "../lib/a11y";
import { bundle, dockTab, farfieldIndex, setDockTab, setFarfieldIndex, setLayers, source, type DockTab } from "../state";
import { sMatrix } from "../lib/sparams";
import { nearestIndex, patternCut, sweep } from "../lib/rf";
import { freqText, ghzText, num, withUnit } from "../lib/format";
import { efficiencyIssue, efficiencyWarningUi } from "../lib/runText";
import { effectiveQuantity, farfieldSummary, QUANTITY_LABEL, quantityGrid, quantityMax } from "../lib/farfieldQuantity";
import { patternQuantity } from "../lib/patternQuantityStore";
import { PatternQuantitySelect, totalEffText } from "./FarfieldCard";
import type { Signals } from "../types";
import ComparePicker from "../compare/ComparePicker";
import { compareBundles, comparing, cutPhi, pinned, setCutPhi, setZPart, zPart } from "../compare/store";
import { compareCuts, compareLines, compareSParams, compareTable, interp, pairQuantity, SERIES_COLORS, traces, type GroupedTable } from "../compare/series";
import { examplesSParams, multiPort, SParamChart, SParamSmith, SParamSmithCompare, SParamTools, sparamTable } from "./SParamView";
import { compareSParamQuantities } from "../compare/series";
import { plotQuantities } from "../charts/plotQuantities";
import PanelBoundary from "./PanelBoundary";
// the Array tab (beam steering) only loads when opened
const ArrayPanel = lazy(() => import("./ArrayPanel"));
import { arrayActive, farfieldOverride, hasArray, scanPhi, setArrayActive, steeredFarField } from "../lib/arrayStore";
import { copyResultData, exportResultCsv, resultDataTable, type ResultDataOptions } from "../designer/resultData";
import { resultDataFormat, tableFormat, writeResultDataFormat, type ResultDataFormat } from "../designer/resultDataPreference";
import { exportResultTouchstone } from "../designer/resultTouchstone";
import type { ResultView } from "../designer/resultFocus";
import { downloadMessage, revealDownloadedFile, type DownloadResult } from "../lib/download";
import { exportNotice, registerSurfaceExports } from "../components/exportContext";
import { saveVisibleFigure, visibleFigureSvgs } from "../components/visibleFigure";
import { t } from "../i18n";
import "../styles/result-views.css";

/** label: an i18n key, translated at render */
const ALL_TABS: { id: DockTab; label: string }[] = [
  { id: "reflection", label: "dock.results.reflection" },
  { id: "impedance", label: "dock.results.impedance" },
  { id: "smith", label: "dock.results.smith" },
  { id: "pattern", label: "dock.results.pattern" },
  { id: "array", label: "dock.results.array" },
  { id: "signals", label: "dock.results.signals" },
];

type TableData = GroupedTable;

const safeFilenamePart = (value: string) => value
  .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
  .replace(/\s+/g, "-")
  .replace(/-+/g, "-")
  .replace(/^[.\- ]+|[.\- ]+$/g, "");

function examplesCsvFilename(b: NonNullable<ReturnType<typeof bundle>>, view: ResultView) {
  const model = safeFilenamePart(b.model?.id || b.name || "model") || "model";
  const rawSource = source().replace(/\\/g, "/").split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  let run = safeFilenamePart(rawSource) || "example";
  const modelPrefix = `${model}-`;
  if (run.toLowerCase().startsWith(modelPrefix.toLowerCase())) run = run.slice(modelPrefix.length) || "example";
  const suffix = safeFilenamePart(view) || "results";
  return `${model}-${run}-${suffix}.csv`;
}

export function DataTable(props: { data: TableData }) {
  return (
    <div class="data-table-wrap">
      <table class="table table-data">
        <thead>
          <Show when={props.data.groups}>
            <tr class="th-group">
              <For each={props.data.groups}>{(g) => <th colSpan={g.span} scope="colgroup">{g.label}</th>}</For>
            </tr>
          </Show>
          <tr><For each={props.data.columns}>{(c) => <th class="num">{c}</th>}</For></tr>
        </thead>
        <tbody>
          <For each={props.data.rows}>
            {(r) => <tr><For each={r}>{(v) => <td class="num">{typeof v === "number" ? num(v, 3) : v}</td>}</For></tr>}
          </For>
        </tbody>
      </table>
    </div>
  );
}

const every = <T,>(arr: T[], maxRows = 201) => {
  const step = Math.max(1, Math.ceil(arr.length / maxRows));
  return arr.map((_, i) => i).filter((i) => i % step === 0 || i === arr.length - 1);
};

export default function Dock() {
  const dataFormat = resultDataFormat;
  // a narrow dock folds its labelled tool buttons to icons (a class, not a container query: the
  // Figure menu is position: fixed inside the dock, and size containment would re-anchor it)
  let dockEl: HTMLElement | undefined;
  const dockSize = useSize(() => dockEl);
  const [showTable, setShowTable] = createSignal(false);
  const [dataAction, setDataAction] = createSignal("");
  // a saved file: Show in folder beside the status
  const [savedPath, setSavedPath] = createSignal<string | null>(null);
  // the Copy data button itself says "Copied" for a moment; failures go to the status line
  const [copied, setCopied] = createSignal(false);
  let actionTimer: ReturnType<typeof setTimeout> | undefined;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  // a saved file's "Saved to … · Show in folder" stays long enough to click
  const reportAction = (message: string, ms = 5000, path: string | null = null) => {
    if (actionTimer) clearTimeout(actionTimer);
    exportNotice(message);
    setDataAction(message); setSavedPath(path);
    actionTimer = setTimeout(() => { setDataAction(""); setSavedPath(null); }, ms);
  };
  const reportSaved = (result: DownloadResult) => {
    if (result.status === "saved" && result.path) reportAction(t("results.toolbar.savedTo", { path: result.path }), 30_000, result.path);
    else reportAction(downloadMessage(result));
  };
  onCleanup(() => { if (actionTimer) clearTimeout(actionTimer); if (copiedTimer) clearTimeout(copiedTimer); });
  const resultView = (): ResultView | null => {
    switch (dockTab()) {
      case "reflection": return "sparams";
      case "impedance": return "impedance";
      case "smith": return "smith";
      case "pattern": return "pattern";
      default: return null;
    }
  };
  const selectedDataRuns = () => {
    const current = bundle();
    if (!current || !comparing()) return undefined;
    return [{ file: source() || current.name || "current", bundle: current },
      ...pinned().filter((p) => p.bundle?.results && p.file !== source()).map((p) => ({ file: p.file, bundle: p.bundle! }))];
  };
  // Copy data and CSV follow the plot: the picked S_ij, dB or phase, the Smith chart's port
  const dataOptions = (): ResultDataOptions => ({ format: tableFormat(dataFormat()), ...(multiPort()
    ? { pairs: examplesSParams.selectedPairs(), sparamMode: examplesSParams.mode(), smithPort: examplesSParams.smithPort() }
    : {}) });
  const copyData = () => {
    const b = bundle();
    const view = resultView();
    if (!b || !view) return;
    void copyResultData(b, view, storedFF()?.f, selectedDataRuns(), dataOptions()).then((result) => {
      if (!result.ok) { reportAction(t("results.toolbar.copyFailed", { error: result.message })); return; }
      if (copiedTimer) clearTimeout(copiedTimer);
      setCopied(true);
      copiedTimer = setTimeout(() => setCopied(false), 1600);
    });
  };
  const exportData = async () => {
    const b = bundle();
    const view = resultView();
    if (b && view) {
      const filename = examplesCsvFilename(b, view);
      try {
        reportSaved(await exportResultCsv(b, view, filename, storedFF()?.f, selectedDataRuns(), dataOptions()));
      } catch (error) { reportAction(t("dock.results.downloadFailed", { error: String(error) })); }
    }
  };
  const exportTouchstone = async () => {
    const b = bundle();
    if (!b?.results) return;
    const base = (source().replace(/\\/g, "/").split("/").pop() || b.name || "result").replace(/\.json$/i, "");
    try {
      reportSaved(await exportResultTouchstone(b, base, selectedDataRuns()));
    } catch (error) { reportAction(t("results.toolbar.touchstoneFailed", { error: String(error) })); }
  };
  onMount(()=> {
    const ready=()=>!!bundle()?.results;
    const chart=()=>ready() && visibleFigureSvgs(dockEl??null).length>0;
    const figure=(format:"png"|"svg")=>saveVisibleFigure(dockEl??null,`${bundle()?.model.id??"result"}-${dockTab()}`,format,`${bundle()?.name??""} — ${t(ALL_TABS.find((x)=>x.id===dockTab())?.label??"dock.results.reflection")}`);
    onCleanup(registerSurfaceExports("examples-result",{ready:chart,screenshot:()=>figure("png"),actions:()=>[
      {id:"result-csv",label:t("contextExport.resultCsv"),disabled:!ready()||!resultView()||!resultDataTable(bundle(),resultView()??"sparams",storedFF()?.f,dataOptions()).rows.length,reason:t("contextExport.noData"),run:exportData},
      {id:"result-touchstone",label:t("contextExport.touchstone"),disabled:!ready()||!sMatrix(bundle())?.pairs.length,reason:t("contextExport.noSParameters"),run:exportTouchstone},
      ...(["svg","png"] as const).map(format=>({id:`figure-${format}`,label:t("contextExport.figureFormat",{format:format.toUpperCase()}),disabled:!chart(),reason:t("contextExport.noChart"),run:()=>figure(format)})),
    ]}));
  });
  const onResultKey: JSX.EventHandler<HTMLElement, KeyboardEvent> = (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "c" || !bundle()?.results || !resultView()) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']") || window.getSelection()?.toString()) return;
    e.preventDefault();
    copyData();
  };
  // N-port bundles: "S-parameters" instead of "Reflection" (S11 only while comparing); an Array
  // tab when element patterns exist
  const multi = () => multiPort() && !comparing();
  // comparing a multi-port project: the picked S_ij of every compared project (run colour, pair dash)
  const spCompare = () => multiPort() && comparing();
  const TABS_ = createMemo(() =>
    ALL_TABS.filter((tab) => tab.id !== "array" || hasArray()).map((tab) => (tab.id === "reflection" && multiPort() ? { ...tab, label: "dock.results.sparams" } : tab)),
  );
  createEffect(() => {
    if (dockTab() === "array" && !hasArray()) setDockTab("reflection");
  });
  const sw = createMemo(() => (bundle() ? sweep(bundle()!) : null));
  const fGHz = createMemo(() => sw()?.f.map((f) => f / 1e9) ?? []);
  const ffs = () => bundle()?.results?.farfield ?? [];
  const storedFF = () => ffs()[Math.min(farfieldIndex(), ffs().length - 1)];
  // the steered array pattern (Array tab) replaces the stored one while it is active
  const ff = () => farfieldOverride() ?? storedFF();
  // array projects: the Pattern tab overlays the array pattern and the selected element's pattern
  // in one cut plane, which follows the scan plane of the Array tab
  const arrayMode = () => hasArray() && !comparing();
  const oneFreqPorts = () => ffs().length > 1 && ffs().every((f) => f.port !== undefined && f.f === ffs()[0].f);
  createEffect(on(scanPhi, (v) => hasArray() && setCutPhi(v), { defer: true }));
  const signals = () => {
    const s = bundle()?.results?.signals;
    return s && "time_ns" in s ? (s as Signals) : null;
  };

  // one marker per far-field frequency (multi-port runs store one pattern per port at the same f);
  // a marker stands for the selected pattern at its frequency, else the first one there
  const ffMarks = createMemo(() => {
    const seen = new Map<number, number>();
    ffs().forEach((f, i) => {
      if (!seen.has(f.f) || i === farfieldIndex()) seen.set(f.f, i);
    });
    return [...seen].map(([f, i]) => ({ f, index: i }));
  });
  // far-field frequencies in the frequency format of every chart readout (2.400, 8.000)
  const markers = () => ffMarks().map(({ f, index }) => ({ x: f / 1e9, label: ghzText(f / 1e9), active: storedFF()?.f === f, index }));
  const selectMarker = (k: number) => selectFF(ffMarks()[k]?.index ?? 0);
  const smithMarks = () => ffMarks().map(({ f }) => ({ f, label: freqText(f) }));
  const bands = () => (bundle()?.results?.bands ?? []).map((b) => ({ x0: b.f_lo / 1e9, x1: b.f_hi / 1e9 }));
  const selectFF = (i: number) => {
    setFarfieldIndex(i);
    setLayers("pattern", true);
  };
  const pickFreq = (xGHz: number) => {
    const list = ffs();
    if (!list.length) return;
    selectFF(nearestIndex(list.map((f) => f.f / 1e9), xGHz));
  };

  // comparison: current project + pinned ones, interpolated onto one frequency grid
  const cmp = createMemo(() => (comparing() ? traces(bundle(), compareBundles()) : null));
  const cmpS11 = createMemo(() => (cmp() ? compareLines(cmp()!, (s) => s.s11Db) : null));
  const cmpZ = createMemo(() => (cmp() ? compareLines(cmp()!, (s) => (zPart() === "re" ? s.zRe : s.zIm)) : null));
  const cmpCuts = createMemo(() => {
    const q = patternQuantity();
    return cmp() && ff() ? compareCuts(cmp()!, ff()!.f, cutPhi(), ff(), (b, x) => quantityGrid(b, x, q)) : null;
  });
  /** the quantity the cuts show (directivity for the array overlay and entries without it) */
  const shownQuantity = () => (arrayMode() && steeredFarField() && storedFF()) || !bundle() || !ff() ? "directivity" : effectiveQuantity(bundle()!, ff()!, patternQuantity());
  const ffSummary = createMemo(() => (bundle() && ff() ? farfieldSummary(bundle()!, ff()!) : null));
  const cmpSpData = createMemo(() => (spCompare() && cmp() ? compareSParams(cmp()!, examplesSParams.selectedPairs(), examplesSParams.mode()) : null));
  const cmpSp = createMemo(() => (spCompare() && cmp() ? compareSParamQuantities(cmp()!, examplesSParams.selectedPairs(), dataFormat(), examplesSParams.mode()) : null));
  const cmpSingleNamed = createMemo(() => {
    if (multiPort() || dataFormat() === "plot" || !cmp()) return null;
    const groups = compareSParamQuantities(cmp()!, [[1, 1]], dataFormat());
    return groups.some((g) => g.series.length) ? groups : null;
  });
  const singleNamed = createMemo(() => {
    if (dataFormat() === "plot" || multiPort()) return [];
    const m = examplesSParams.S();
    if (m?.pairs.length) return plotQuantities(m.pairs.flatMap((p, k) => { const v = m.get(p[0], p[1]); return v ? [{ id: `${p[0]},${p[1]}`, label: `S${p[0]}${p[1]}`, color: `--al-series-${k + 1}`, x: m.f.map(f => f / 1e9), re: v.re, im: v.im }] : []; }), dataFormat());
    const s = sw();
    return dataFormat() === "db" && s ? [{ key: "db", title: t("chart.q.magnitudeDb"), yLabel: t("chart.q.magnitudeDb"), kind: "reflection" as const, series: [{ id: "s11", label: "|S11|", color: "--al-series-1", x: s.f.map(f => f / 1e9), y: s.s11Db }] }] : [];
  });
  const spDb = () => examplesSParams.mode() === "db";
  // Smith: S11 of compared projects and of reference data that has phase (magnitude-only
  // curves cannot be placed on the chart)
  const smithOverlays = () =>
    (cmp() ?? []).slice(1).map((t, i) => ({ t, color: SERIES_COLORS[i + 1] }))
      .filter(({ t }) => t.sweep.f.length && (t.bundle as { reference?: { phaseKnown: boolean } }).reference?.phaseKnown !== false)
      .map(({ t, color }) => ({ label: t.label, color, re: t.sweep.s11Re, im: t.sweep.s11Im }));
  /** tooltip extras for the current project at the hovered x (index into the chart's grid) */
  const extraAt = (i: number) => {
    const s = sw();
    const x = (cmpS11()?.x ?? fGHz())[i];
    const f = fGHz();
    if (!s || x === undefined || x < f[0] - 1e-9 || x > f[f.length - 1] + 1e-9) return [];
    const k = nearestIndex(f, x);
    const pre = cmp() ? `${cmp()![0].label}: ` : "";
    return [
      { label: `${pre}VSWR`, value: Number.isFinite(s.vswr[k]) ? num(s.vswr[k], 2) : "∞" },
      { label: `${pre}Zin`, value: `${num(s.zRe[k], 1)} ${s.zIm[k] >= 0 ? "+" : "−"} j${num(Math.abs(s.zIm[k]), 1)} Ω` },
    ];
  };

  const s11Series = (): Series[] => (sw() ? [{ id: "s11", label: "|S11|", color: "--al-series-1", x: fGHz(), y: sw()!.s11Db }] : []);
  const zSeries = (): Series[] =>
    sw()
      ? [
          { id: "re", label: "Re Zin", color: "--al-series-1", x: fGHz(), y: sw()!.zRe },
          { id: "im", label: "Im Zin", color: "--al-series-2", x: fGHz(), y: sw()!.zIm },
        ]
      : [];
  const sigSeries = (): Series[] => {
    const s = signals();
    return s
      ? [
          { id: "inc", label: t("dock.results.incident"), color: "--al-series-1", x: s.time_ns, y: s.u_inc },
          { id: "ref", label: t("dock.results.reflected"), color: "--al-series-2", x: s.time_ns, y: s.u_ref },
        ]
      : [];
  };
  const cuts = () => {
    const f = ff();
    const b = bundle();
    if (!f || !b) return [];
    const half = !!b.half_space;
    const arr = steeredFarField();
    const el = storedFF();
    if (arrayMode() && arr && el) {
      const a = patternCut(arr.theta, arr.phi, arr.directivity_dbi, cutPhi(), half);
      const e = patternCut(el.theta, el.phi, el.directivity_dbi, cutPhi(), half);
      return [
        { id: "array", label: `${t("farfield.arrayTag")} · φ = ${cutPhi()}°`, color: "--al-series-1", angle: a.angle, value: a.value },
        { id: "element", label: `${t("dock.results.element", { port: el.port ?? "?" })} · φ = ${cutPhi()}°`, color: "--al-series-2", angle: e.angle, value: e.value },
      ];
    }
    const grid = quantityGrid(b, f, patternQuantity());
    const a = patternCut(f.theta, f.phi, grid, 0, half);
    const c = patternCut(f.theta, f.phi, grid, 90, half);
    return [
      { id: "phi0", label: "φ = 0° (xz)", color: "--al-series-1", angle: a.angle, value: a.value },
      { id: "phi90", label: "φ = 90° (yz)", color: "--al-series-2", angle: c.angle, value: c.value },
    ];
  };

  const compareTableData = (): TableData | null => {
    const tr = cmp();
    if (!tr) return null;
    switch (dockTab()) {
      case "reflection": {
        const sp = cmpSpData();
        if (sp) {
          // one column group per project, one column per picked S_ij (a pair it lacks shows "—")
          const pairs = examplesSParams.selectedPairs();
          const nan = sp.x.map(() => NaN);
          return compareTable("f (GHz)", sp.x, tr, pairs.map((p) => ({
            label: `${pairQuantity(p, examplesSParams.mode())} (${spDb() ? "dB" : "°"})`,
            values: (i) => sp.series.find((s) => s.id === `cmp-${i}-${p[0]},${p[1]}`)?.y ?? nan,
          })));
        }
        const c = cmpS11()!;
        const vswr = tr.map((r) => interp(r.sweep.f.map((f) => f / 1e9), r.sweep.vswr.map((v) => (Number.isFinite(v) ? v : NaN)), c.x));
        return compareTable("f (GHz)", c.x, tr, [
          { label: "|S11| (dB)", values: (i) => c.series[i].y },
          { label: "VSWR", values: (i) => vswr[i] },
        ]);
      }
      case "impedance": {
        const x = cmpZ()!.x;
        const re = tr.map((r) => interp(r.sweep.f.map((f) => f / 1e9), r.sweep.zRe, x));
        const im = tr.map((r) => interp(r.sweep.f.map((f) => f / 1e9), r.sweep.zIm, x));
        return compareTable("f (GHz)", x, tr, [
          { label: "Re Zin (Ω)", values: (i) => re[i] },
          { label: "Im Zin (Ω)", values: (i) => im[i] },
        ]);
      }
      case "pattern": {
        const cuts = cmpCuts();
        if (!cuts?.length) return null;
        const angles = [...new Set(cuts.flatMap((c) => c.angle))].sort((a, b) => a - b);
        return compareTable("θ (°)", angles, cuts, [
          { label: `φ = ${cutPhi()}° (dBi)`, values: (i) => interp(cuts[i].angle, cuts[i].value, angles) },
        ]);
      }
      default:
        return null;
    }
  };

  const table = createMemo<TableData | null>(() => {
    const s = sw();
    const c = compareTableData();
    if (c) return c;
    if (multi() && (dockTab() === "reflection" || dockTab() === "smith")) return sparamTable();
    switch (dockTab()) {
      case "reflection":
      case "smith":
        if (!s) return null;
        return {
          columns: ["f (GHz)", "|S11| (dB)", "VSWR", "Re Γ", "Im Γ"],
          rows: every(s.f).map((i) => [fGHz()[i], s.s11Db[i], Number.isFinite(s.vswr[i]) ? s.vswr[i] : "∞", s.s11Re[i], s.s11Im[i]]),
        };
      case "impedance":
        if (!s) return null;
        return { columns: ["f (GHz)", "Re Zin (Ω)", "Im Zin (Ω)"], rows: every(s.f).map((i) => [fGHz()[i], s.zRe[i], s.zIm[i]]) };
      case "pattern": {
        const c = cuts();
        if (!c.length) return null;
        return {
          columns: ["θ (°)", `${c[0].label} (dBi)`, `${c[1].label} (dBi)`],
          rows: c[0].angle.map((a, i) => [a, c[0].value[i], c[1].value[i] ?? "—"]),
        };
      }
      case "signals": {
        const g = signals();
        if (!g) return null;
        return { columns: ["t (ns)", t("dock.results.col.incident"), t("dock.results.col.reflected")], rows: every(g.time_ns).map((i) => [g.time_ns[i], g.u_inc[i], g.u_ref[i]]) };
      }
      default:
        return null;
    }
  });

  const onTabKey: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (e) => {
    const TABS = TABS_();
    const i = TABS.findIndex((t) => t.id === dockTab());
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (next < 0 && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const tab = TABS[(next + TABS.length) % TABS.length];
    setDockTab(tab.id);
    (e.currentTarget.querySelector(`[data-tab="${tab.id}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <section class="dock" classList={{ "dock-narrow": dockSize().w > 0 && dockSize().w < 1160 }} ref={dockEl} aria-label={t("dock.results.aria")} tabIndex={0} onKeyDown={onResultKey}>
      <span class="visually-hidden" role="status">{dataAction()}</span>
      <DockResizeHandle />
      <div class="dock-bar">
        <div class="tabs" role="tablist" aria-label={t("dock.results.views")} onKeyDown={onTabKey}>
          <For each={TABS_()}>
            {(tab) => (
              <button
                role="tab"
                data-tab={tab.id}
                class="tab"
                aria-selected={dockTab() === tab.id}
                tabindex={dockTab() === tab.id ? 0 : -1}
                onClick={() => setDockTab(tab.id)}
              >
                {t(tab.label)}
              </button>
            )}
          </For>
        </div>
        <div class="dock-tools">
          <Show when={multiPort() && (dockTab() === "reflection" || dockTab() === "smith")}>
            <SParamTools smith={dockTab() === "smith"} format={dataFormat()} />
          </Show>
          <Show when={(dockTab() === "pattern" || dockTab() === "reflection" || dockTab() === "array") && ffs().length}>
            <div class="freq-chips" role="radiogroup" aria-label={t("farfield.frequency")} onKeyDown={radioGroupKeys}>
              {/* one frequency with a pattern per driven port: name the frequency once, chips are ports */}
              <span class="dock-hint">{t("dock.results.farField")}<Show when={oneFreqPorts()}> {num(ffs()[0].f / 1e9, 3)} GHz</Show></span>
              <For each={ffs()}>
                {(f, i) => (
                  <button role="radio" aria-checked={farfieldIndex() === i()} class="chip-btn" classList={{ active: farfieldIndex() === i() }} onClick={() => selectFF(i())}
                    title={f.port ? t("dock.results.embeddedTitle", { port: f.port }) : undefined}>
                    <Show when={oneFreqPorts()} fallback={<>
                      {num(f.f / 1e9, 3)} GHz
                      {/* multi-port runs store one pattern per driven port at the same frequency */}
                      <Show when={f.port && ffs().some((g, j) => j !== i() && g.f === f.f)}> · P{f.port}</Show>
                    </>}>P{f.port}</Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={comparing() && dockTab() === "impedance"}>
            <div class="seg seg-sm" role="radiogroup" aria-label={t("results.impedance.part")} onKeyDown={radioGroupKeys}>
              <button class="seg-btn" role="radio" aria-checked={zPart() === "re"} onClick={() => setZPart("re")}>Re</button>
              <button class="seg-btn" role="radio" aria-checked={zPart() === "im"} onClick={() => setZPart("im")}>Im</button>
            </div>
          </Show>
          <Show when={arrayMode() && (dockTab() === "pattern" || dockTab() === "array") && storedFF()}>
            <div class="seg seg-sm" role="radiogroup" aria-label={t("dock.results.pattern3dAria")} onKeyDown={radioGroupKeys}
              title={t("dock.results.pattern3dTitle")}>
              <button class="seg-btn" role="radio" aria-checked={arrayActive()} onClick={() => setArrayActive(true)}>{t("farfield.arrayTag")}</button>
              <button class="seg-btn" role="radio" aria-checked={!arrayActive()} onClick={() => setArrayActive(false)}>{t("dock.results.element", { port: storedFF()!.port ?? "?" })}</button>
            </div>
          </Show>
          <Show when={dockTab() === "pattern" && bundle() && storedFF() && !(arrayMode() && farfieldOverride())}>
            <PatternQuantitySelect bundle={bundle()!} ff={storedFF()!} class="btn btn-ghost btn-sm" />
          </Show>
          <Show when={(comparing() || arrayMode()) && dockTab() === "pattern"}>
            <div class="seg seg-sm" role="radiogroup" aria-label={t("results.pattern.cut")} onKeyDown={radioGroupKeys}>
              <button class="seg-btn" role="radio" aria-checked={cutPhi() === 0} onClick={() => setCutPhi(0)}>φ 0°</button>
              <button class="seg-btn" role="radio" aria-checked={cutPhi() === 90} onClick={() => setCutPhi(90)}>φ 90°</button>
            </div>
          </Show>
          <ComparePicker />
          <FigureMenu />
          <Show when={bundle()?.results && resultView()}>
            <select class="btn btn-ghost btn-sm result-format" aria-label={t("results.toolbar.formatAria")} value={dataFormat()} onChange={(event) => {
              const value = event.currentTarget.value as ResultDataFormat;
                writeResultDataFormat(value);
            }}>
              <option value="plot">{t("results.format.plot")}</option><option value="db">dB</option><option value="db_phase">{t("results.format.dbPhase")}</option><option value="re_im">Re/Im</option><option value="mag_phase">{t("results.format.magPhase")}</option><option value="all">{t("results.format.all")}</option>
            </select>
            <button class="btn btn-ghost btn-sm dock-copy" classList={{ copied: copied() }} onClick={copyData} title={t("dock.results.copyDataTitle")}
              aria-live="polite">
              <Show when={copied()} fallback={<><Copy size={14} aria-hidden="true" /> {t("results.toolbar.copyData")}</>}><Check size={14} aria-hidden="true" /> {t("results.toolbar.copied")}</Show>
            </button>
            <button class="btn btn-ghost btn-sm" onClick={exportData} title={t("results.toolbar.csvTitle")} aria-label={t("results.toolbar.csvTitle")}><FileSpreadsheet size={14} aria-hidden="true" /> <span class="btn-short">CSV</span></button>
          </Show>
          <Show when={dataAction()}>
            <span class="dock-data-status" role="status" aria-live="polite">
              {dataAction()}
              <Show when={savedPath()}>{(path) => (
                <button class="dock-reveal" onClick={() => void revealDownloadedFile(path())
                  .catch((error) => reportAction(t("results.toolbar.showInFolderFailed", { error: String(error) })))}>{t("results.toolbar.showInFolder")}</button>
              )}</Show>
            </span>
          </Show>
          <Show when={bundle()?.results}>
            <button class="btn btn-ghost btn-sm" onClick={exportTouchstone} title={t("results.toolbar.touchstoneTitle")} aria-label={t("results.toolbar.touchstoneTitle")}><FileChartLine size={14} aria-hidden="true" /> <span class="btn-short">{`.s${Math.max(1, sMatrix(bundle())?.ports.length ?? 1)}p`}</span></button>
          </Show>
          <button class="btn btn-ghost btn-sm" aria-pressed={showTable()} onClick={() => setShowTable(!showTable())} title={showTable() ? t("dock.results.backToChart") : t("dock.results.showData")}>
            <Table2 size={14} aria-hidden="true" /> {t("results.tab.table")}
          </button>
        </div>
      </div>

      <div class="dock-body">
        <Show when={bundle()?.results} fallback={bundle() && <div class="panel-empty">{(bundle() as { preview?: boolean } | null)?.preview
          ? <>{t("dock.results.previewOnly")}</>
          : <>{t("dock.results.geometryOnlyBefore")}<span class="mono">fairbeam run</span>{t("dock.results.geometryOnlyAfter")}</>}</div>}>
          <Show when={!showTable()} fallback={<Show when={table()} fallback={<div class="panel-empty">{t("dock.results.noData")}</div>}>{(t) => <DataTable data={t()} />}</Show>}>
            <Switch>
              <Match when={dockTab() === "reflection" && cmpSp()}>
                {(groups) => <Show when={groups().some((g) => g.series.length)} fallback={<div class="panel-empty">{t("sparams.chooseOneAbove")}</div>}>
                  <StackedCharts groups={groups()} inspectionChart={`examples:${source()}:reflection`}
                    ariaLabel={(g) => t("results.aria.vsFrequency", { title: g.title, what: t("dock.results.aria.pickedCompared") })} />
                </Show>}
              </Match>
              <Match when={dockTab() === "smith" && spCompare() && cmp()}>
                {(t) => <SParamSmithCompare store={examplesSParams} traces={t()} markers={smithMarks()} />}
              </Match>
              <Match when={dockTab() === "reflection" && multi()}>
                <SParamChart markers={markers()} onMarker={selectMarker} inspectionKey={`examples:${source()}:reflection`} format={dataFormat()} />
              </Match>
              <Match when={dockTab() === "reflection" && cmpSingleNamed()}>
                {(groups) => <StackedCharts groups={groups()} inspectionChart={`examples:${source()}:reflection`}
                  ariaLabel={(g) => t("results.aria.vsFrequency", { title: g.title, what: t("dock.results.aria.reflectionCompared") })} />}
              </Match>
              <Match when={dockTab() === "reflection" && dataFormat() !== "plot" && !multiPort() && cmp() && !cmpSingleNamed()}>
                <div class="panel-empty">{t("dock.results.noComplex")}</div>
              </Match>
              <Match when={dockTab() === "reflection" && dataFormat() !== "plot" && singleNamed().length}>
                <StackedCharts groups={singleNamed()} inspectionChart={`examples:${source()}:reflection`}
                  ariaLabel={(g) => t("results.aria.vsFrequency", { title: g.title, what: t("results.aria.inputReflection") })}
                  pane={(g) => (g.key === "db" ? { markers: markers(), onMarker: selectMarker, onPick: pickFreq, bands: bands() } : {})} />
              </Match>
              <Match when={dockTab() === "reflection" && dataFormat() !== "plot" && !multiPort() && !cmp() && !singleNamed().length}>
                <div class="panel-empty">{t("dock.results.noComplex")}</div>
              </Match>
              <Match when={dockTab() === "smith" && multi()}>
                <SParamSmith markers={smithMarks()} />
              </Match>
              <Match when={dockTab() === "array"}>
                <PanelBoundary name="Array panel">
                  <ArrayPanel />
                </PanelBoundary>
              </Match>
              <Match when={dockTab() === "reflection" && sw()}>
                <LineChart
                  ariaLabel={t("dock.results.aria.s11")}
                  series={cmpS11()?.series ?? s11Series()}
                  inspection={{ key: `examples:${source()}:reflection:db`, chart: `examples:${source()}:reflection`, kind: "reflection" }}
                  xLabel={t("chart.frequencyGHz")}
                  yLabel="|S11| (dB)"
                  yDomain={quantityDomain({ key: "db", series: cmpS11()?.series ?? s11Series() })}
                  hlines={quantityLines({ key: "db", kind: "reflection", series: cmpS11()?.series ?? s11Series() })}
                  bands={bands()}
                  markers={markers()}
                  onMarker={selectMarker}
                  onPick={pickFreq}
                  yFormat={(v) => v.toFixed(1)}
                  extra={extraAt}
                />
              </Match>
              <Match when={dockTab() === "impedance" && sw()}>
                <LineChart
                  ariaLabel={cmpZ() ? t(zPart() === "re" ? "dock.results.aria.zReCompared" : "dock.results.aria.zImCompared") : t("results.aria.impedance")}
                  series={cmpZ()?.series ?? zSeries()}
                  inspection={{ key: `examples:${source()}:impedance:${zPart()}`, chart: `examples:${source()}:impedance`, kind: "other" }}
                  xLabel={t("chart.frequencyGHz")}
                  yLabel={cmpZ() ? `${zPart() === "re" ? "Re" : "Im"} Zin (Ω)` : "Zin (Ω)"}
                  hlines={cmpZ() && zPart() === "im" ? [{ y: 0, label: "" }] : [{ y: sw()!.zRef, label: t("results.impedance.referenceLine", { z: num(sw()!.zRef, sw()!.zRef >= 100 ? 0 : 1) }) }, { y: 0, label: "" }]}
                  yFormat={(v) => v.toFixed(1)}
                />
              </Match>
              <Match when={dockTab() === "smith" && sw()}>
                <SmithChart
                  ariaLabel={t("results.aria.smith")}
                  f={sw()!.f}
                  re={sw()!.s11Re}
                  im={sw()!.s11Im}
                  zRe={sw()!.zRe}
                  zIm={sw()!.zIm}
                  zRef={sw()!.zRef}
                  markers={smithMarks()}
                  label={cmp()?.[0]?.label}
                  overlays={smithOverlays()}
                />
              </Match>
              <Match when={dockTab() === "pattern"}>
                <Show when={ff()} fallback={<div class="panel-empty">{t("dock.results.noFarField")}</div>}>
                  <div class="pattern-view">
                    <PolarChart
                      ariaLabel={cmpCuts() ? t("dock.results.aria.cutCompared", { quantity: QUANTITY_LABEL[shownQuantity()], phi: cutPhi() }) : t("results.pattern.cuts", { quantity: QUANTITY_LABEL[shownQuantity()] })}
                      series={cmpCuts() ?? cuts()}
                      directLabels={!!cmpCuts()}
                      max={Math.ceil(Math.max(...[shownQuantity() === "directivity" ? ff()!.dmax_dbi : quantityMax(bundle()!, ff()!, shownQuantity()), ...(cmpCuts() ?? cuts()).flatMap((c) => c.value)].filter(Number.isFinite), -60))}
                      range={30}
                      half={!!bundle()?.half_space && !(cmp() ?? []).some((t) => !t.bundle.half_space)}
                      unit="dBi"
                    />
                    <dl class="kv pattern-stats">
                      <Show
                        when={arrayMode() && steeredFarField() && storedFF()}
                        fallback={<>
                          <dt>{t("results.pattern.frequency")}</dt><dd class="mono">{freqText(ff()!.f)}</dd>
                          <dt>Dmax</dt><dd class="mono">{withUnit(num(ff()!.dmax_dbi, 2), "dBi")}</dd>
                          <dt>{t("farfield.quantity.gain")}</dt><dd class="mono">{ff()!.gain_dbi !== undefined ? withUnit(num(ff()!.gain_dbi, 2), "dBi") : "—"}</dd>
                          <dt>{t("farfield.quantity.realized")}</dt><dd class="mono">{ff()!.realized_gain_dbi !== undefined ? withUnit(num(ff()!.realized_gain_dbi, 2), "dBi") : "—"}</dd>
                          <dt>{t("farfield.radEff")}</dt>
                          <dd class="mono" classList={{ "cell-warn": !!efficiencyIssue(ff()!) }} title={efficiencyWarningUi(ff()!) ?? undefined}>
                            {ff()!.rad_efficiency !== null ? t("format.percent", { value: num(ff()!.rad_efficiency! * 100, 1) }) : "—"}
                            <Show when={efficiencyIssue(ff()!)}> <TriangleAlert size={12} aria-label={t("farfield.overUnity")} /></Show>
                          </dd>
                          <dt title={t("farfield.totalTitlePort")}>{t("farfield.total")}</dt>
                          <dd class="mono">{ffSummary()?.totalEff != null ? totalEffText(ffSummary()!.totalEff!) : "—"}</dd>
                        </>}
                      >
                        <dt>{t("results.pattern.frequency")}</dt><dd class="mono">{num(storedFF()!.f / 1e9, 3)} GHz</dd>
                        <dt>{t("dock.results.arrayDmax")}</dt><dd class="mono">{num(steeredFarField()!.dmax_dbi, 2)} dBi</dd>
                        <dt>{t("dock.results.elementDmax", { port: storedFF()!.port ?? "?" })}</dt><dd class="mono">{num(storedFF()!.dmax_dbi, 2)} dBi</dd>
                        <dt>{t("dock.results.elementGain")}</dt><dd class="mono">{storedFF()!.gain_dbi !== undefined ? `${num(storedFF()!.gain_dbi, 2)} dBi` : "—"}</dd>
                        <dt>{t("dock.results.in3d")}</dt><dd>{farfieldOverride() ? t("dock.results.arrayCurrentFeed") : t("dock.results.element", { port: storedFF()!.port ?? "?" })}</dd>
                      </Show>
                      <dt>θ = 0°</dt><dd>{t("dock.results.zenith")}</dd>
                    </dl>
                  </div>
                </Show>
              </Match>
              <Match when={dockTab() === "signals"}>
                <Show when={signals()} fallback={<div class="panel-empty">{t("dock.results.noSignals")}</div>}>
                  <LineChart
                    ariaLabel={t("dock.results.aria.signals")}
                    series={sigSeries()}
                    xLabel={t("dock.results.timeNs")}
                    yLabel={t("dock.results.portVoltage")}
                    xFormat={(v) => v.toFixed(2)}
                    yFormat={(v) => v.toFixed(3)}
                  />
                </Show>
              </Match>
            </Switch>
          </Show>
        </Show>
      </div>
    </section>
  );
}
