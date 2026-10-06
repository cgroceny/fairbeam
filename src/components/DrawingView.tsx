import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { Download, Maximize, Minus, Plus, TriangleAlert } from "lucide-solid";
import { bundle } from "../state";
import { DEFAULT_DRAWING_OPTIONS, technicalDrawing, type DrawingOptions, type SheetOption } from "../drawing/drawing";
import { saveBlob, svgSizeMm, svgToPdf, svgToPng } from "../drawing/render";
import { radioGroupKeys } from "../lib/a11y";
import { downloadFailedMessage, downloadMessage, revealDownloadedFile } from "../lib/download";
import { exportNotice, geometryAvailable, registerSurfaceExports } from "../components/exportContext";
import DrawingMoreOptions from "./DrawingMoreOptions";
import { t } from "../i18n";

const KEY = "fairbeam.drawing";
const MM = 96 / 25.4;

function storedOptions(): DrawingOptions {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<DrawingOptions>;
    return { ...DEFAULT_DRAWING_OPTIONS, ...v, date: undefined };
  } catch {
    return { ...DEFAULT_DRAWING_OPTIONS };
  }
}

export default function DrawingView() {
  let stage!: HTMLDivElement;
  const [opt, setOpt] = createStore<DrawingOptions>(storedOptions());
  const [view, setView] = createStore({ k: 1, x: 0, y: 0 });
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [saveNote, setSaveNote] = createSignal<{ text: string; path?: string } | null>(null);

  const result = createMemo(() => {
    const b = bundle();
    if (!b) return null;
    try {
      return technicalDrawing(b, { ...opt });
    } catch (e) {
      console.error(e);
      return null;
    }
  });
  const svgMarkup = () => result()?.svg.replace(/<\?xml[^>]*\?>/, "") ?? "";
  const size = () => (result() ? svgSizeMm(result()!.svg) : [297, 210]);

  createEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        sheet: opt.sheet, projection: opt.projection, isometric: opt.isometric, dimensions: opt.dimensions,
        paramLabels: opt.paramLabels, isoHidden: opt.isoHidden, legend: opt.legend, viewDims: opt.viewDims ? { ...opt.viewDims } : undefined,
      }));
    } catch {
      /* private mode */
    }
  });

  // Free area for the sheet: the stage minus the toolbars actually drawn over it (they wrap at
  // narrow widths, so measure them instead of assuming a fixed band).
  const insets = () => {
    const r = stage.getBoundingClientRect();
    const gap = 12;
    let top = 0;
    let bottom = 0;
    const huds = [...stage.querySelectorAll<HTMLElement>(".dv-hud > *"), ...(stage.parentElement?.querySelectorAll<HTMLElement>(".stage-switch") ?? [])];
    for (const el of huds) {
      const b = el.getBoundingClientRect();
      if (!b.height) continue;
      if (b.top + b.height / 2 < r.top + r.height / 2) top = Math.max(top, b.bottom - r.top);
      else bottom = Math.max(bottom, r.bottom - b.top);
    }
    return { top: top + gap, bottom: bottom + gap, side: 16 };
  };
  const fit = () => {
    const r = stage.getBoundingClientRect();
    const [w, h] = size();
    const m = insets();
    const availW = Math.max(40, r.width - 2 * m.side);
    const availH = Math.max(40, r.height - m.top - m.bottom);
    const k = Math.max(0.05, Math.min(availW / (w * MM), availH / (h * MM)));
    setView({ k, x: (r.width - w * MM * k) / 2, y: m.top + (availH - h * MM * k) / 2 });
  };
  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    const r = stage.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    const k = Math.min(40, Math.max(0.05, view.k * factor));
    const f = k / view.k;
    setView({ k, x: px - (px - view.x) * f, y: py - (py - view.y) * f });
  };

  onMount(() => {
    fit();
    const ro = new ResizeObserver(() => fit());
    ro.observe(stage);
    onCleanup(() => ro.disconnect());
  });
  createEffect(on([() => opt.sheet, bundle], () => queueMicrotask(fit), { defer: true }));

  // pan (drag) and zoom (wheel / pinch)
  let drag: { id: number; x: number; y: number; vx: number; vy: number } | null = null;
  const onDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest(".dv-hud")) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("dragging");
  };
  const onMove = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    setView({ x: drag.vx + e.clientX - drag.x, y: drag.vy + e.clientY - drag.y });
  };
  const onUp = (e: PointerEvent) => {
    if (drag && e.pointerId === drag.id) {
      drag = null;
      stage.classList.remove("dragging");
    }
  };
  const onWheel = (e: WheelEvent) => {
    if ((e.target as HTMLElement).closest(".dv-hud")) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest(".dv-hud")) return;
    if (e.key === "+" || e.key === "=") zoomAt(1.25);
    else if (e.key === "-") zoomAt(0.8);
    else if (e.key === "0") fit();
    else return;
    e.preventDefault();
  };

  const baseName = () => `${(bundle()?.model.id ?? "fairbeam").replace(/[^A-Za-z0-9_-]+/g, "_")}_drawing_${opt.sheet}`;
  const run = async (label: string, fn: () => Promise<{ name: string; status: "requested" | "saved" | "cancelled" | "failed"; path?: string }>) => {
    setBusy(label);
    setError(null);
    setSaveNote(null);
    try {
      const result = await fn();
      exportNotice(downloadMessage(result));
      setSaveNote({ text: downloadMessage(result), path: result.status === "saved" ? result.path : undefined });
    } catch (e) {
      console.error(e);
      exportNotice(downloadFailedMessage(label,e));
      setSaveNote({ text: downloadFailedMessage(label, e) });
    } finally {
      setBusy(null);
    }
  };
  const exportSvg = () => { if (result() && !busy() && geometryAvailable()) void run("SVG", async () => saveBlob(`${baseName()}.svg`, result()!.svg, "image/svg+xml")); };
  const exportPdf = () => { if (!result() || busy() || !geometryAvailable()) return; return run("PDF", async () => saveBlob(`${baseName()}.pdf`, await svgToPdf(result()!.svg, bundle()!.name), "application/pdf")); };
  const exportPng = () => { if (!result() || busy() || !geometryAvailable()) return; return run("PNG", async () => saveBlob(`${baseName()}.png`, await svgToPng(result()!.svg, 300))); };

  onMount(()=>onCleanup(registerSurfaceExports("drawing", {ready:()=>!!result() && !busy() && geometryAvailable(),screenshot:exportPng,
    actions:()=>[...["svg","pdf","png"] as const].map(format=>({id:`drawing-${format}`,label:t("contextExport.drawingFormat",{format:format.toUpperCase()}),disabled:!result()||!!busy()||!geometryAvailable(),reason:t("contextExport.noGeometry"),run:format==="svg"?exportSvg:format==="pdf"?exportPdf:exportPng}))})));

  // label and title: i18n keys
  const sheets: { id: SheetOption; label: string; title: string }[] = [
    { id: "A4", label: "drawing.sheet.a4", title: "drawing.sheet.a4Title" },
    { id: "A3", label: "drawing.sheet.a3", title: "drawing.sheet.a3Title" },
    { id: "figure", label: "drawing.sheet.figure", title: "drawing.sheet.figureTitle" },
  ];

  return (
    <div
      class="drawing-view"
      ref={stage}
      tabindex={0}
      aria-label={t("drawing.aria")}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onWheel={onWheel}
      onKeyDown={onKey}
    >
      <div
        class="dv-sheet"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        // eslint-disable-next-line solid/no-innerhtml
        innerHTML={svgMarkup()}
      />

      <div class="dv-hud dv-hud-tl" role="toolbar" aria-label={t("drawing.options")}>
        <div class="seg" role="radiogroup" aria-label={t("drawing.sheet")} onKeyDown={radioGroupKeys}>
          <For each={sheets}>
            {(s) => (
              <button class="seg-btn" role="radio" aria-checked={opt.sheet === s.id} classList={{ active: opt.sheet === s.id }} title={t(s.title)} onClick={() => setOpt("sheet", s.id)}>
                {t(s.label)}
              </button>
            )}
          </For>
        </div>
        <div class="seg" role="radiogroup" aria-label={t("drawing.projection")} onKeyDown={radioGroupKeys}>
          <button class="seg-btn" role="radio" aria-checked={opt.projection === "third"} classList={{ active: opt.projection === "third" }} title={t("drawing.thirdTitle")} onClick={() => setOpt("projection", "third")}>
            {t("drawing.third")}
          </button>
          <button class="seg-btn" role="radio" aria-checked={opt.projection === "first"} classList={{ active: opt.projection === "first" }} title={t("drawing.firstTitle")} onClick={() => setOpt("projection", "first")}>
            {t("drawing.first")}
          </button>
        </div>
        <label class="toggle dv-toggle">
          <input type="checkbox" checked={opt.isometric} onChange={(e) => setOpt("isometric", e.currentTarget.checked)} />
          <span class="toggle-box" aria-hidden="true" />
          <span>{t("drawing.isometric")}</span>
        </label>
        <label class="toggle dv-toggle">
          <input type="checkbox" checked={opt.dimensions} onChange={(e) => setOpt("dimensions", e.currentTarget.checked)} />
          <span class="toggle-box" aria-hidden="true" />
          <span>{t("drawing.dimensions")}</span>
        </label>
        <DrawingMoreOptions opt={opt} setOpt={setOpt} />
      </div>

      <div class="dv-hud dv-hud-tr">
        <div class="seg dv-export" role="group" aria-label={t("drawing.download")}>
          <span class="dv-export-icon" title={t("drawing.downloadTitle")}><Download size={14} aria-hidden="true" /></span>
          <button class="seg-btn" onClick={exportSvg} disabled={!result() || !!busy() || !geometryAvailable()} title={t("drawing.svgTitle")} aria-label={t("drawing.downloadAs", { format: "SVG" })}>
            SVG
          </button>
          <button class="seg-btn" onClick={exportPdf} disabled={!result() || !!busy() || !geometryAvailable()} aria-busy={busy() === "PDF"} title={t("drawing.pdfTitle")} aria-label={t("drawing.downloadAs", { format: "PDF" })}>
            {busy() === "PDF" ? "PDF…" : "PDF"}
          </button>
          <button class="seg-btn" onClick={exportPng} disabled={!result() || !!busy() || !geometryAvailable()} aria-busy={busy() === "PNG"} title={t("drawing.pngTitle")} aria-label={t("drawing.downloadAs", { format: "PNG" })}>
            {busy() === "PNG" ? "PNG…" : "PNG"}
          </button>
        </div>
      </div>

      <div class="dv-hud dv-hud-bl">
        <Show when={result()}>
          {(r) => (
            <span class="readout dv-readout">
              {opt.sheet === "figure" ? t("drawing.readoutFigure", { w: Math.round(r().widthMm), h: Math.round(r().heightMm) }) : t("drawing.readoutSheet", { sheet: opt.sheet, scale: r().scaleLabel })} · {t(opt.projection === "third" ? "drawing.readoutThird" : "drawing.readoutFirst")} · mm
            </span>
          )}
        </Show>
        <Show when={error() ?? result()?.warnings[0]}>
          <span class="status status-warn" role="status">
            <TriangleAlert size={13} aria-hidden="true" /> {error() ?? result()?.warnings[0]}
          </span>
        </Show>
        <Show when={saveNote()}>{(note) => <span class="status" role="status" aria-live="polite">{note().text}{note().path && <button class="linklike" onClick={() => void revealDownloadedFile(note().path!).catch((e) => setSaveNote({ text: t("results.toolbar.showInFolderFailed", { error: String(e) }) }))}>{t("results.toolbar.showInFolder")}</button>}</span>}</Show>
      </div>

      <div class="dv-hud dv-hud-br">
        <div class="seg dv-zoom-group" role="toolbar" aria-label={t("drawing.zoom")}>
          <button class="seg-btn dv-icon" onClick={() => zoomAt(0.8)} title={t("drawing.zoomOutTitle")} aria-label={t("drawing.zoomOut")}><Minus size={14} aria-hidden="true" /></button>
          <span class="dv-zoom" aria-live="polite" aria-label={t("drawing.zoomAria", { n: Math.round(view.k * 100) })}>{t("drawing.zoomPct", { n: Math.round(view.k * 100) })}</span>
          <button class="seg-btn dv-icon" onClick={() => zoomAt(1.25)} title={t("drawing.zoomInTitle")} aria-label={t("drawing.zoomIn")}><Plus size={14} aria-hidden="true" /></button>
          <button class="seg-btn dv-icon" onClick={fit} title={t("drawing.fitTitle")} aria-label={t("drawing.fit")}><Maximize size={14} aria-hidden="true" /></button>
        </div>
      </div>
    </div>
  );
}
