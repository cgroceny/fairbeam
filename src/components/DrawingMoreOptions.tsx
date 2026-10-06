import { createSignal, For, onCleanup, Show } from "solid-js";
import type { SetStoreFunction } from "solid-js/store";
import { SlidersHorizontal } from "lucide-solid";
import type { DrawingOptions } from "../drawing/drawing";
import { radioGroupKeys } from "../lib/a11y";
import type { ViewId } from "../drawing/geometry";
import { t } from "../i18n";

type LabelMode = "auto" | "on" | "off";

/**
 * "More" options for the technical drawing: parametric dimension labels, dashed hidden edges in
 * the isometric view, a line-type legend on the sheet and per-view dimension switches.
 * Composes the shared .menu / .toggle / .seg primitives.
 */
export default function DrawingMoreOptions(props: { opt: DrawingOptions; setOpt: SetStoreFunction<DrawingOptions> }) {
  let root!: HTMLDivElement;
  let trigger!: HTMLButtonElement;
  let menu: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [pos, setPos] = createSignal({ top: 0, left: 0 });

  const labelMode = (): LabelMode => (props.opt.paramLabels === undefined ? "auto" : props.opt.paramLabels ? "on" : "off");
  const setLabelMode = (m: LabelMode) => props.setOpt("paramLabels", m === "auto" ? undefined : m === "on");
  /** the views with dimensions; labels are drawingOptions.view.<id> */
  const views: ViewId[] = ["top", "front", "side"];
  const viewOn = (id: ViewId) => props.opt.viewDims?.[id] !== false;
  const setView = (id: ViewId, on: boolean) => props.setOpt("viewDims", { ...(props.opt.viewDims ?? {}), [id]: on });

  const close = (focus = true) => {
    setOpen(false);
    document.removeEventListener("pointerdown", onDoc);
    window.removeEventListener("resize", onResize);
    if (focus) trigger.focus();
  };
  const onDoc = (e: PointerEvent) => !root.contains(e.target as Node) && close(false);
  const onResize = () => close(false);
  const toggle = () => {
    if (open()) return close(false);
    const r = trigger.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left });
    setOpen(true);
    document.addEventListener("pointerdown", onDoc);
    window.addEventListener("resize", onResize);
    queueMicrotask(() => {
      if (menu) {
        const m = menu.getBoundingClientRect();
        setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 8 - m.width)) });
      }
      menu?.querySelector<HTMLElement>("button, input")?.focus();
    });
  };
  onCleanup(() => close(false));
  const onKey = (e: KeyboardEvent) => {
    if (open() && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div class="figure-menu" ref={root} onKeyDown={onKey}>
      <button
        ref={trigger}
        class="btn btn-ghost btn-sm dv-btn"
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={toggle}
        title={t("drawingOptions.moreTitle")}
      >
        <SlidersHorizontal size={14} aria-hidden="true" /> <span class="btn-label">{t("drawingOptions.more")}</span>
      </button>
      <Show when={open()}>
        <div class="menu stack-sm" role="dialog" aria-label={t("drawingOptions.menuAria")} ref={menu} style={{ top: `${pos().top}px`, left: `${pos().left}px` }}>
          <div class="menu-row">
            <span class="menu-label">{t("drawingOptions.paramLabels")}</span>
            <div class="seg seg-sm" role="radiogroup" aria-label={t("drawingOptions.paramLabelsAria")} onKeyDown={radioGroupKeys}>
              <For each={["auto", "on", "off"] as LabelMode[]}>
                {(m) => (
                  <button
                    class="seg-btn"
                    role="radio"
                    aria-checked={labelMode() === m}
                    classList={{ active: labelMode() === m }}
                    title={t(`drawingOptions.mode.${m}.title`)}
                    onClick={() => setLabelMode(m)}
                  >
                    {t(`drawingOptions.mode.${m}`)}
                  </button>
                )}
              </For>
            </div>
          </div>
          <div class="menu-row" role="group" aria-label={t("drawingOptions.perViewAria")}>
            <span class="menu-label">{t("drawingOptions.dimensionsIn")}</span>
            <For each={views}>
              {(v) => (
                <button
                  class="chip-btn"
                  aria-pressed={viewOn(v)}
                  classList={{ active: viewOn(v) }}
                  disabled={!props.opt.dimensions}
                  onClick={() => setView(v, !viewOn(v))}
                >
                  {t(`drawingOptions.view.${v}`)}
                </button>
              )}
            </For>
          </div>
          <div class="toggle-list">
            <label class="toggle">
              <input type="checkbox" checked={!!props.opt.isoHidden} onChange={(e) => props.setOpt("isoHidden", e.currentTarget.checked)} />
              <span class="toggle-box" aria-hidden="true" />
              <span>{t("drawingOptions.isoHidden")}</span>
            </label>
            <label class="toggle">
              <input type="checkbox" checked={!!props.opt.legend} onChange={(e) => props.setOpt("legend", e.currentTarget.checked)} />
              <span class="toggle-box" aria-hidden="true" />
              <span>{t("drawingOptions.legend")}</span>
            </label>
          </div>
        </div>
      </Show>
    </div>
  );
}
