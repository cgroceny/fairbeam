import { createSignal, For, onCleanup, Show } from "solid-js";
import { ChevronDown, Download } from "lucide-solid";
import { bundle } from "../state";
import { sMatrix } from "../lib/sparams";
import { compareBundles, comparing } from "../compare/store";
import { traces } from "../compare/series";
import { downloadFailedMessage, downloadMessage, revealDownloadedFile } from "../lib/download";
import type { Bundle } from "../types";
import { titledSvg } from "./figureTitle";
import { fmt as nf, t, tEn, type Params } from "../i18n";

// The figure generators and the PDF path (jsPDF, svg2pdf) load on first use, not with the app.
type Charts = typeof import("../drawing/charts");
const loadCharts = () => import("../drawing/charts");
const loadRender = () => import("../drawing/render");

type Fmt = "svg" | "pdf" | "png";

/** Pixels per inch of a PNG figure: print resolution, also sharp on a slide. */
export const FIGURE_PNG_DPI = 300;

/** "Export figure" menu in the dock bar (Examples) and the result toolbar (Design): B&W publication
 * charts as SVG, PDF or a 300 dpi PNG with the figure's title above it. The figures hold the active run
 * only; while a comparison is on screen the menu says so, names the run it exports and marks every
 * entry, so a saved figure is never mistaken for the overlaid chart. `source` is the run to draw (the
 * Examples dock's open project by default), `scope` the comparison on screen, `stem` the file name stem. */
export default function FigureMenu(props: {
  source?: () => Bundle | null | undefined;
  scope?: () => { label: string; left: number } | null;
  stem?: () => string;
  /** where the save notes go (the toolbar's feedback line), instead of the menu's own status */
  report?: (text: string, path?: string) => void;
} = {}) {
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  const [open, setOpen] = createSignal(false);
  const [fmt, setFmt] = createSignal<Fmt>("svg");
  const [wide, setWide] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [saveNote, setNote] = createSignal<{ text: string; path?: string } | null>(null);
  // a toolbar with its own feedback line (Design) takes the notes; the dock bar shows them here
  const setSaveNote = (note: { text: string; path?: string } | null) => (props.report && note ? props.report(note.text, note.path) : setNote(note));
  // positioned fixed (the dock bar may clip), then kept inside the viewport: it opens below the
  // trigger, flips above when there is no room, and is clamped at the left/right edges
  let menu: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ top: 0, left: 0 });
  const place = () => {
    if (!menu) return;
    const r = trigger.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const edge = 8;
    const below = r.bottom + 4;
    const top = below + m.height > window.innerHeight - edge && r.top - 4 - m.height >= edge ? r.top - 4 - m.height : Math.max(edge, Math.min(below, window.innerHeight - edge - m.height));
    const left = Math.max(edge, Math.min(r.right - m.width, window.innerWidth - edge - m.width));
    setPos({ top, left });
  };
  const onViewport = (e: Event) => {
    if (e.type === "scroll" && menu?.contains(e.target as Node)) return; // scrolling the menu itself
    close(false);
  };

  /** While comparing: the active run's trace label and how many compared traces stay out. */
  const scope = () => {
    if (props.scope) return props.scope();
    if (!comparing()) return null;
    const ts = traces(bundle(), compareBundles());
    return ts.length > 1 ? { label: ts[0].label, left: ts.length - 1 } : null;
  };

  const items = () => {
    const b = props.source ? props.source() : bundle();
    if (!b?.results) return [];
    // label: an i18n key (the menu shows it in the UI language, the PDF title in English)
    const list: { label: string; params?: Params; name: (C: Charts) => string; make: (C: Charts, w: number) => string | null }[] = [
      { label: "figure.s11", name: () => "s11", make: (C, w) => C.s11Figure(b, { widthMm: w }) },
      { label: "figure.zin", name: () => "zin", make: (C, w) => C.zinFigure(b, { widthMm: w }) },
      { label: "figure.smith", name: () => "smith", make: (C, w) => C.smithFigure(b, { widthMm: w }) },
    ];
    const S = b.ports.length > 1 ? sMatrix(b) : null;
    if (S && S.ports.length > 1) {
      list.push({ label: "figure.sReflections", name: () => "sparams_reflection", make: (C, w) => C.sparamFigure(b, "reflection", { widthMm: w }) });
      list.push({ label: "figure.sCoupling", name: () => "sparams_transmission", make: (C, w) => C.sparamFigure(b, "transmission", { widthMm: w }) });
    }
    const ffs = b.results.farfield;
    ffs.forEach((ff, i) => {
      const multi = ffs.some((g, j) => j !== i && g.f === ff.f) && ff.port != null;
      list.push({ label: multi ? "figure.patternPort" : "figure.pattern", params: { f: ff.f / 1e9, port: ff.port }, name: (C) => `pattern_${C.ffTag(ffs, i)}`, make: (C, w) => C.patternFigure(b, i, { widthMm: w }) });
    });
    return list.map((item) => ({ ...item, source: b }));
  };
  /** an entry's label: shown (UI language, local decimal separator) or for the PDF title (English) */
  const labelOf = (it: ReturnType<typeof items>[number], en = false) => {
    const f = typeof it.params?.f === "number" ? it.params.f : undefined;
    const params = f === undefined ? it.params : { ...it.params, f: en ? f.toFixed(3) : nf.fixed(f, 3) };
    return en ? tEn(it.label, params) : t(it.label, params);
  };

  const close = (focus = true) => {
    setOpen(false);
    document.removeEventListener("pointerdown", onDoc);
    window.removeEventListener("resize", onViewport);
    window.removeEventListener("scroll", onViewport, true);
    if (focus) trigger.focus();
  };
  const onDoc = (e: PointerEvent) => !root.contains(e.target as Node) && close(false);
  const toggle = () => {
    if (saving()) return;
    const next = !open();
    setOpen(next);
    if (next) {
      const r = trigger.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: Math.max(8, r.right - 248) });
      document.addEventListener("pointerdown", onDoc);
      window.addEventListener("resize", onViewport);
      window.addEventListener("scroll", onViewport, true);
      queueMicrotask(() => {
        place();
        (root.querySelector("[role=menuitem]") as HTMLElement | null)?.focus();
      });
    } else close(false);
  };
  onCleanup(() => close(false));

  const save = async (it: ReturnType<typeof items>[number]) => {
    if (saving()) return;
    const b = it.source;
    const requestedWide = wide();
    const requestedFormat = fmt();
    const title = `${b.name} — ${labelOf(it, true)}${scope() ? ` (${tEn("figure.activeRunOnlyTitle")})` : ""}`;
    const stem = (props.stem?.() || b.model.id).replace(/[^A-Za-z0-9_.-]+/g, "_");
    let name = t("figure.fallbackName", { label: labelOf(it) });
    setSaving(true);
    close();
    setSaveNote({ text: t("figure.preparing", { label: labelOf(it) }) });
    try {
      const [C, R] = await Promise.all([loadCharts(), loadRender()]);
      const w = requestedWide ? C.COLUMN_WIDTH.double : C.COLUMN_WIDTH.single;
      const svg = it.make(C, w);
      if (!svg) { setSaveNote({ text: t("figure.unavailable") }); return; }
      const base = `${stem}_${it.name(C)}${requestedWide ? "_wide" : ""}`;
      name = `${base}.${requestedFormat}`;
      // PNG: the same black-and-white figure at print resolution, its title on the picture
      const result = requestedFormat === "svg" ? await R.saveBlob(name, svg, "image/svg+xml")
        : requestedFormat === "png" ? await R.saveBlob(name, await R.svgToPng(titledSvg(svg, title), FIGURE_PNG_DPI), "image/png")
          : await R.saveBlob(name, await R.svgToPdf(svg, title), "application/pdf");
      setSaveNote({ text: downloadMessage(result), path: result.status === "saved" ? result.path : undefined });
    } catch (e) { setSaveNote({ text: downloadFailedMessage(name, e) }); }
    finally { setSaving(false); }
  };

  const menuTargets = (within: ParentNode | undefined = menu) => {
    if (!within) return [] as HTMLElement[];
    return [...within.querySelectorAll<HTMLElement>("[role=menuitem], [role=menuitemradio]")].filter((el) =>
      !el.hidden && !el.matches(":disabled") && el.getAttribute("aria-disabled") !== "true" && !el.closest("[hidden]") && el.getClientRects().length > 0,
    );
  };

  const onKey = (e: KeyboardEvent) => {
    if (!open() || !menu) return;
    const active = e.target as HTMLElement;
    const nestedMenu = active.closest('[role="menu"]');
    if (nestedMenu && nestedMenu !== menu) return;
    // Let editable fields, selects, and true radio groups keep their own arrow-key behavior.
    if (active.closest('input, select, textarea, [contenteditable="true"], [role="radiogroup"]')) return;
    const els = menuTargets();
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close(false); // let focus move on naturally
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      els[(i + (e.key === "ArrowDown" ? 1 : -1) + els.length) % els.length]?.focus();
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && document.activeElement?.getAttribute("role") === "menuitemradio") {
      e.preventDefault();
      const group = active.closest('[role="group"]');
      const choices = menuTargets(group ?? undefined).filter((el) => el.getAttribute("role") === "menuitemradio");
      const choiceIndex = choices.indexOf(document.activeElement as HTMLElement);
      if (choices.length) choices[(choiceIndex + (e.key === "ArrowRight" ? 1 : -1) + choices.length) % choices.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      els[e.key === "Home" ? 0 : els.length - 1]?.focus();
    }
  };

  return (
    <div class="figure-menu" ref={root} onKeyDown={onKey}>
      <button
        ref={trigger}
        class="btn btn-ghost btn-sm"
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-disabled={saving()}
        aria-label={t("figure.export")}
        disabled={!items().length}
        onClick={toggle}
        title={scope() ? t("figure.titleScoped") : t("figure.title")}
      >
        <Download size={14} aria-hidden="true" /> <span class="btn-label">{t("figure.button")}</span> <ChevronDown size={12} aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div class="menu" role="menu" aria-label={t("figure.export")} ref={menu} style={{ top: `${pos().top}px`, left: `${pos().left}px` }}>
          <div class="menu-row">
            <span class="cluster-sm" role="group" aria-label={t("figure.widthAria")}>
              <button role="menuitemradio" aria-checked={!wide()} class="chip-btn" classList={{ active: !wide() }} onClick={() => setWide(false)}>{nf.num(8.8, 1)} cm</button>
              <button role="menuitemradio" aria-checked={wide()} class="chip-btn" classList={{ active: wide() }} onClick={() => setWide(true)}>18 cm</button>
            </span>
            <span class="menu-sep" />
            <span class="cluster-sm" role="group" aria-label={t("figure.formatAria")}>
              <button role="menuitemradio" aria-checked={fmt() === "svg"} class="chip-btn" classList={{ active: fmt() === "svg" }} onClick={() => setFmt("svg")}>SVG</button>
              <button role="menuitemradio" aria-checked={fmt() === "pdf"} class="chip-btn" classList={{ active: fmt() === "pdf" }} onClick={() => setFmt("pdf")}>PDF</button>
              <button role="menuitemradio" aria-checked={fmt() === "png"} class="chip-btn" classList={{ active: fmt() === "png" }} onClick={() => setFmt("png")} title={t("figure.pngTitle", { dpi: FIGURE_PNG_DPI })}>PNG</button>
            </span>
          </div>
          <Show when={scope()}>
            {(sc) => (
              <p class="menu-note" id="figure-scope">
                <strong>{t("figure.activeRunOnly")}</strong> {t("figure.scopeNote", { label: sc().label, count: sc().left })}
              </p>
            )}
          </Show>
          <For each={items()}>
            {(it) => (
              <button role="menuitem" class="menu-item" aria-describedby={scope() ? "figure-scope" : undefined} onClick={() => save(it)}>
                {labelOf(it)}
                <Show when={scope()}>
                  <span class="menu-item-scope">{t("figure.activeRun")}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <span class="status" role="status" aria-live="polite" hidden={!saveNote()}>{saveNote()?.text}</span>
      <Show when={saveNote()?.path}>{(path) => <button class="linklike" onClick={() => void revealDownloadedFile(path()).catch((e) => setSaveNote({ text: t("results.toolbar.showInFolderFailed", { error: String(e) }) }))}>{t("results.toolbar.showInFolder")}</button>}</Show>
    </div>
  );
}
