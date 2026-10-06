// The navigation tree's menu for rows that are not geometry (sections, folders, runs, results,
// parameters). It looks and behaves like the part/shape menu (ContextMenu.tsx, #44): same classes and
// icon size, focus on open, Arrow keys wrap, Home/End jump, Escape returns to the row, Tab closes.
import { createEffect, onCleanup, onMount, For, Show, type Component } from "solid-js";
import { Portal } from "solid-js/web";

export type TreeMenuAction = { label: string; run: () => void; icon?: Component };

const WIDTH = 256; // .menu min-width (drawing.css) plus its border

export default function TreeMenu(props: { x: number; y: number; label: string; actions: TreeMenuAction[]; close: (restore?: boolean) => void; trigger: HTMLElement }) {
  let el!: HTMLDivElement;
  onMount(() => { el.querySelector<HTMLElement>("button")?.focus(); });
  createEffect(() => {
    const away = (e: PointerEvent) => { if (!el.contains(e.target as Node)) props.close(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); props.close(); } };
    const viewport = () => props.close(false);
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", key, true);
    window.addEventListener("resize", viewport); window.addEventListener("scroll", viewport, true);
    onCleanup(() => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key, true); window.removeEventListener("resize", viewport); window.removeEventListener("scroll", viewport, true); });
  });
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab") { props.close(false); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const items = [...el.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return <Portal><div ref={el} class="menu dz-context-menu nt-context-menu" role="menu" aria-label={props.label}
    style={{ left: `${Math.max(8, Math.min(props.x, window.innerWidth - WIDTH - 8))}px`, top: `${Math.max(8, Math.min(props.y, window.innerHeight - props.actions.length * 29 - 16))}px` }}
    onContextMenu={(e) => e.preventDefault()} onKeyDown={onKeyDown}>
    <For each={props.actions}>{(a) => <button class="menu-item" role="menuitem" onClick={() => { props.close(); a.run(); }}>
      <Show when={a.icon}>{(() => { const I = a.icon!; return <I aria-hidden="true" />; })()}</Show>{a.label}
    </button>}</For>
  </div></Portal>;
}
