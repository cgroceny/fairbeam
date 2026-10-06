// F6 / Shift+F6: move the focus between the main panes of the designer, in reading order. Each pane
// is a labelled region that shows a focus ring while it has the focus from this shortcut.
import { t } from "../i18n/index.ts";

export const PANES = [
  { id: "tree", selector: ".panel-left", label: "panes.tree" },
  { id: "ribbon", selector: ".rb-stack", label: "panes.ribbon" },
  { id: "main", selector: ".dw-main", label: "panes.main" },
  { id: "dock", selector: ".dw-dock", label: "panes.dock" },
  { id: "properties", selector: ".panel-right", label: "panes.properties" },
] as const;
export type PaneId = (typeof PANES)[number]["id"];

/** The pane after (dir 1) or before (dir -1) `current` among the panes that are on screen. With no
 * current pane, F6 goes to the first and Shift+F6 to the last. Null when no pane is available. */
export function nextPane(current: PaneId | null, dir: 1 | -1, available: readonly PaneId[] = PANES.map((p) => p.id)): PaneId | null {
  const order = PANES.map((p) => p.id).filter((id) => available.includes(id) || id === current);
  if (!order.length) return null;
  const at = current ? order.indexOf(current) : -1;
  if (at < 0) return dir === 1 ? order[0] : order[order.length - 1];
  for (let step = 1; step <= order.length; step++) {
    const id = order[(at + dir * step + order.length * step) % order.length];
    if (available.includes(id)) return id;
  }
  return null;
}

const visible = (el: HTMLElement) => el.getClientRects().length > 0;

/** Focus the next pane. The panes are found by their place in the workspace; the first call tags them
 * (region role, name, tabindex -1) so they are also announced when reached this way. */
export function cyclePanes(dir: 1 | -1): PaneId | null {
  const found = new Map<PaneId, HTMLElement>();
  for (const p of PANES) {
    const el = document.querySelector<HTMLElement>(p.selector);
    if (!el || !visible(el)) continue;
    el.setAttribute("role", "region");
    el.setAttribute("aria-label", t(p.label));
    el.setAttribute("data-pane", p.id);
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    found.set(p.id, el);
  }
  const active = document.activeElement as HTMLElement | null;
  const current = PANES.find((p) => found.get(p.id)?.contains(active))?.id ?? null;
  const target = nextPane(current, dir, [...found.keys()]);
  if (!target) return null;
  for (const el of found.values()) el.classList.remove("pane-ring");
  const el = found.get(target)!;
  el.classList.add("pane-ring");
  // the ring shows while the focus is in the pane (:focus-within, designer.css) and until the mouse is used
  document.addEventListener("pointerdown", () => el.classList.remove("pane-ring"), { once: true, capture: true });
  el.focus({ preventScroll: true });
  return target;
}
