import { createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { ChevronDown, Download } from "lucide-solid";
import { t } from "../i18n";

/** Export the plot currently shown in the Design result tab. */
export default function ResultFigureMenu(props: { disabled: boolean; save: (format: "png" | "svg") => Promise<void> }) {
  let trigger!: HTMLButtonElement, menu!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [position, setPosition] = createSignal({ top: 0, left: 0 });
  const close = (focus = false) => { setOpen(false); if (focus) trigger.focus(); };
  const outside = (event: PointerEvent) => {
    if (open() && !menu.contains(event.target as Node) && !trigger.contains(event.target as Node)) close();
  };
  const viewport = () => close();
  document.addEventListener("pointerdown", outside);
  window.addEventListener("resize", viewport);
  window.addEventListener("scroll", viewport, true);
  onCleanup(() => {
    document.removeEventListener("pointerdown", outside);
    window.removeEventListener("resize", viewport);
    window.removeEventListener("scroll", viewport, true);
  });
  const toggle = () => {
    if (open()) { close(); return; }
    const box = trigger.getBoundingClientRect();
    setPosition({ top: box.bottom + 4, left: box.left });
    setOpen(true);
    queueMicrotask(() => {
      const rect = menu.getBoundingClientRect();
      setPosition({ top: Math.max(8, Math.min(box.bottom + 4, window.innerHeight - rect.height - 8)), left: Math.max(8, Math.min(box.left, window.innerWidth - rect.width - 8)) });
      menu.querySelector<HTMLButtonElement>("button")?.focus();
    });
  };
  const save = async (format: "png" | "svg") => {
    if (saving() || props.disabled) return;
    setSaving(true); close(true);
    try { await props.save(format); } finally { setSaving(false); }
  };
  return <>
    <button ref={trigger} class="btn btn-ghost btn-sm" disabled={props.disabled || saving()} aria-haspopup="menu" aria-expanded={open()} aria-label={t("results.figure.export")} title={t("results.figure.hint")} onClick={toggle}>
      <Download size={14} aria-hidden="true" /><span class="btn-label">{t("results.figure.button")}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    <Show when={open()}><Portal>
      <div ref={menu} class="menu result-figure-menu" role="menu" aria-label={t("results.figure.export")} style={{ top: `${position().top}px`, left: `${position().left}px` }} onKeyDown={event => {
        const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
        else if (event.key === "Tab") close();
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
      }}>
        <For each={["png", "svg"] as const}>{format => <button class="menu-item" role="menuitem" onClick={() => void save(format)}>{t("contextExport.figureFormat", { format: format.toUpperCase() })}</button>}</For>
      </div>
    </Portal></Show>
  </>;
}
