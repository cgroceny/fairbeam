import { createSignal, onCleanup, onMount } from "solid-js";
import { t } from "../i18n";
import "../styles/result-views.css";

const STORAGE_KEY = "fairbeam.dock-height";
/** The view above the dock keeps this much height (px): a result tab's toolbar and a usable plot. */
export const MIN_VIEW_ABOVE = 320;

/** Shared by the designer and results docks; responsive defaults remain CSS-owned (at most 30 % of
 * the window), but neither the default nor a remembered height may leave the view above the dock less
 * than MIN_VIEW_ABOVE: a height dragged on a large window comes back smaller on a small one. */
export default function DockResizeHandle() {
  let handle!: HTMLDivElement;
  const [height, setHeight] = createSignal(120);
  const [maximum, setMaximum] = createSignal(120);
  let center: HTMLElement;
  let dock: HTMLElement;
  let requested: number | undefined;
  // the CSS default was capped for a short window (not remembered: it follows the window)
  let capped = false;
  let drag: { id: number; y: number; height: number } | undefined;
  const clamp = (value: number) => Math.round(Math.max(120, Math.min(maximum(), value)));
  const apply = (value: number, remember = true) => {
    requested = value;
    capped = false;
    const next = clamp(value);
    center.style.setProperty("--al-dock-user-h", `${next}px`);
    setHeight(next);
    if (remember) {
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* Storage may be disabled. */ }
    }
  };
  onMount(() => {
    center = handle.closest<HTMLElement>(".center")!;
    dock = handle.parentElement!;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored !== null && Number.isFinite(Number(stored)) && Number(stored) >= 120) requested = Number(stored);
    } catch { /* Keep the responsive default. */ }
    const measure = () => {
      // the room of the view above the dock and the dock together
      const above = dock.previousElementSibling as HTMLElement | null;
      const room = above ? dock.getBoundingClientRect().bottom - above.getBoundingClientRect().top : center.clientHeight;
      setMaximum(Math.max(120, Math.min(Math.floor(center.clientHeight * 0.7), Math.floor(room - MIN_VIEW_ABOVE))));
      if (requested !== undefined) apply(requested, false);
      else {
        // the CSS default, unless the window is too short for it and the view above
        if (capped) { center.style.removeProperty("--al-dock-user-h"); capped = false; }
        const natural = Math.round(dock.getBoundingClientRect().height);
        if (natural > maximum() + 1) { center.style.setProperty("--al-dock-user-h", `${maximum()}px`); capped = true; setHeight(maximum()); }
        else setHeight(natural);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(center);
    observer.observe(dock);
    onCleanup(() => { observer.disconnect(); center.style.removeProperty("--al-dock-user-h"); });
  });
  return <div ref={handle} class="dock-resize" role="separator" tabindex={0}
    aria-label={t("resize.dock")} aria-orientation="horizontal" aria-valuemin={120}
    aria-valuemax={maximum()} aria-valuenow={height()} aria-valuetext={`${height()} pixels`}
    title={t("resize.dock.title")}
    onDblClick={() => {
      requested = undefined; capped = false; center.style.removeProperty("--al-dock-user-h");
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be disabled. */ }
    }}
    onPointerDown={(e) => {
      if (e.button !== 0) return;
      e.preventDefault(); handle.focus(); handle.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, y: e.clientY, height: dock.getBoundingClientRect().height };
    }}
    onPointerMove={(e) => { if (drag?.id === e.pointerId) apply(drag.height + drag.y - e.clientY); }}
    onPointerUp={(e) => { if (drag?.id === e.pointerId) { drag = undefined; handle.releasePointerCapture(e.pointerId); } }}
    onPointerCancel={() => { drag = undefined; }} onLostPointerCapture={() => { drag = undefined; }}
    onKeyDown={(e) => {
      const step = e.shiftKey ? 50 : 10;
      const current = dock.getBoundingClientRect().height;
      const next = e.key === "ArrowUp" || e.key === "ArrowLeft" ? current + step
        : e.key === "ArrowDown" || e.key === "ArrowRight" ? current - step
        : e.key === "Home" ? 120 : e.key === "End" ? maximum() : null;
      if (next === null) return;
      e.preventDefault(); e.stopPropagation(); apply(next);
    }}>
    {/* a visible grip: the edge can be dragged (its title says so, and Home / End / the arrow keys move it) */}
    <span class="dock-grip" aria-hidden="true" />
  </div>;
}
