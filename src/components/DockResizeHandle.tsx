import { createSignal, onCleanup, onMount } from "solid-js";
import { t } from "../i18n";

const STORAGE_KEY = "fairbeam.dock-height";

/** Shared by the designer and results docks; responsive defaults remain CSS-owned. */
export default function DockResizeHandle() {
  let handle!: HTMLDivElement;
  const [height, setHeight] = createSignal(120);
  const [maximum, setMaximum] = createSignal(120);
  let center: HTMLElement;
  let dock: HTMLElement;
  let requested: number | undefined;
  let drag: { id: number; y: number; height: number } | undefined;
  const clamp = (value: number) => Math.round(Math.max(120, Math.min(maximum(), value)));
  const apply = (value: number, remember = true) => {
    requested = value;
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
      setMaximum(Math.max(120, Math.floor(center.clientHeight * 0.7)));
      if (requested !== undefined) apply(requested, false);
      else setHeight(Math.round(dock.getBoundingClientRect().height));
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
      requested = undefined; center.style.removeProperty("--al-dock-user-h");
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
    }} />;
}
