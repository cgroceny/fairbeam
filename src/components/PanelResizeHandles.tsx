import { createSignal, onCleanup, onMount } from "solid-js";
import { t } from "../i18n";

/** Edge separators write the same variables as responsive layout defaults. */
export default function PanelResizeHandles() {
  return <><PanelHandle side="left" /><PanelHandle side="right" /></>;
}
function PanelHandle(props: { side: "left" | "right" }) {
  let handle!: HTMLDivElement;
  let workspace!: HTMLElement;
  let requested: number | undefined;
  let drag: { id: number; x: number; width: number } | undefined;
  const [width, setWidth] = createSignal(0);
  const [maximum, setMaximum] = createSignal(480);
  const minimum = 180;
  const variable = `--scaling-${props.side}`;
  const key = `fairbeam.panel-${props.side}-width`;
  const panel = () => workspace.querySelector<HTMLElement>(`:scope > .panel-${props.side}`);
  const apply = (value: number, remember = true) => {
    requested = value;
    const next = Math.round(Math.max(minimum, Math.min(maximum(), value)));
    workspace.style.setProperty(variable, `${next}px`);
    setWidth(next);
    if (remember) try { localStorage.setItem(key, String(next)); } catch { /* Optional storage. */ }
  };
  const reset = () => {
    requested = undefined; workspace.style.removeProperty(variable);
    requestAnimationFrame(() => setWidth(Math.round(panel()?.getBoundingClientRect().width ?? 0)));
    try { localStorage.removeItem(key); } catch { /* Optional storage. */ }
  };
  onMount(() => {
    workspace = handle.parentElement!;
    try { const saved = Number(localStorage.getItem(key)); if (Number.isFinite(saved) && saved >= minimum) requested = saved; } catch { /* Responsive defaults. */ }
    const measure = () => {
      setMaximum(Math.max(minimum, Math.min(600, Math.floor(workspace.clientWidth * 0.35))));
      if (requested !== undefined) apply(requested, false);
      else setWidth(Math.round(panel()?.getBoundingClientRect().width ?? 0));
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(workspace);
    const mutations = new MutationObserver(measure); mutations.observe(workspace, { attributes: true, attributeFilter: ["class"] });
    const resetLayoutEvent = () => reset();
    window.addEventListener("fairbeam:reset-layout", resetLayoutEvent);
    onCleanup(() => { observer.disconnect(); mutations.disconnect(); window.removeEventListener("fairbeam:reset-layout", resetLayoutEvent); });
  });
  return <div ref={handle} class={`panel-resize panel-resize-${props.side}`} role="separator" tabindex={0}
    aria-label={t(props.side === "left" ? "resize.panel.left" : "resize.panel.right")} aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum()} aria-valuenow={width()}
    title={t("resize.panel.title")}
    onDblClick={reset}
    onPointerDown={(e) => {
      if (e.button !== 0) return;
      e.preventDefault(); handle.focus(); handle.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, x: e.clientX, width: panel()?.getBoundingClientRect().width ?? width() };
    }}
    onPointerMove={(e) => { if (drag?.id === e.pointerId) apply(drag.width + (e.clientX - drag.x) * (props.side === "left" ? 1 : -1)); }}
    onPointerUp={(e) => { drag = undefined; handle.releasePointerCapture(e.pointerId); }}
    onPointerCancel={() => { drag = undefined; }} onLostPointerCapture={() => { drag = undefined; }}
    onKeyDown={(e) => {
      const step = e.shiftKey ? 50 : 10;
      const sign = props.side === "left" ? 1 : -1;
      const current = panel()?.getBoundingClientRect().width ?? width();
      const next = e.key === "ArrowRight" ? current + step * sign : e.key === "ArrowLeft" ? current - step * sign
        : e.key === "ArrowUp" ? current + step : e.key === "ArrowDown" ? current - step
        : e.key === "Home" ? minimum : e.key === "End" ? maximum() : null;
      if (next === null) return;
      e.preventDefault(); e.stopPropagation(); apply(next);
    }} />;
}
