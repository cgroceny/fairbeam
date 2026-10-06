// Designer layout: the navigation tree, the bottom dock and the properties panel can each be
// collapsed (tree and properties to a thin strip at the window edge, the dock to its tab row).
// Remembered per browser; storage may be unavailable (private mode, blocked site data).
import { createSignal, untrack } from "solid-js";

type CompactPanel = "tree" | "side" | null;
const [compactViewport, setCompactViewport] = createSignal(false);
const [compactPanel, setCompactPanel] = createSignal<CompactPanel>(null);

if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const media = window.matchMedia("(max-width: 1040px)");
  setCompactViewport(media.matches);
  media.addEventListener("change", (event) => {
    // Preserve the independently remembered desktop choices. A narrow viewport gets one overlay
    // at most; entering it returns focus only when it hides the panel that currently owns focus.
    if (event.matches) {
      const treeOpen = !leftTreePreference();
      const sideOpen = !sidePanelPreference();
      const nextPanel = treeOpen === sideOpen ? null : treeOpen ? "tree" : "side";
      const active = document.activeElement as HTMLElement | null;
      const hideTree = nextPanel !== "tree" && !!active?.closest(".workspace.design-mode .panel-left");
      const hideSide = nextPanel !== "side" && !!active?.closest(".workspace.design-mode .panel-right");
      setCompactPanel(nextPanel);
      setCompactViewport(true);
      if (hideTree || hideSide) queueMicrotask(() => {
        document.querySelector<HTMLElement>(hideTree ? "[data-layout-focus='tree-strip']" : "[data-layout-focus='side-strip']")?.focus({ preventScroll: true });
      });
    } else {
      setCompactViewport(false);
    }
  });
}

function persisted(key: string) {
  let initial = false;
  try { initial = localStorage.getItem(key) === "true"; } catch { /* storage may be unavailable */ }
  const [value, setValue] = createSignal(initial);
  const update = (next: boolean) => {
    setValue(next);
    try { localStorage.setItem(key, String(next)); } catch { /* storage may be unavailable */ }
  };
  return [value, update, () => update(!value())] as const;
}

const [leftTreePreference, setLeftTreeCollapsedRaw] = persisted("fairbeam.leftTreeCollapsed");
const [sidePanelPreference, setSidePanelCollapsedRaw] = persisted("fairbeam.sidePanelCollapsed");
if (compactViewport()) {
  const treeOpen = !leftTreePreference(), sideOpen = !sidePanelPreference();
  setCompactPanel(treeOpen === sideOpen ? null : treeOpen ? "tree" : "side");
}
/** On compact screens one side panel may overlay the canvas. Desktop preferences remain separate. */
export const leftTreeCollapsed = () => compactViewport() ? compactPanel() !== "tree" : leftTreePreference();
// Focus follows the control only when the panel really opens or closes: programmatic reveals of an
// already open panel (the Run panel opening, the Python button) must not pull focus away. Read
// untracked, so an effect that reveals a panel does not start tracking (and undoing) its collapse.
export function setLeftTreeCollapsed(next: boolean) {
  if (compactViewport()) {
    const before = compactPanel();
    const after = next ? (before === "tree" ? null : before) : "tree";
    if (before === after) return;
    setCompactPanel(after);
    queueMicrotask(() => document.querySelector<HTMLElement>(after === "tree" ? "[data-layout-focus='tree-collapse']" : "[data-layout-focus='tree-strip']")?.focus());
    return;
  }
  if (next === untrack(leftTreePreference)) return;
  setLeftTreeCollapsedRaw(next);
  queueMicrotask(() => document.querySelector<HTMLElement>(next ? "[data-layout-focus='tree-strip']" : "[data-layout-focus='tree-collapse']")?.focus());
}
export const toggleLeftTree = () => setLeftTreeCollapsed(!leftTreeCollapsed());
export const [bottomDockCollapsed, setBottomDockCollapsed, toggleBottomDock] = persisted("fairbeam.bottomDockCollapsed");
export const sidePanelCollapsed = () => compactViewport() ? compactPanel() !== "side" : sidePanelPreference();
export function setSidePanelCollapsed(next: boolean) {
  if (compactViewport()) {
    const before = compactPanel();
    const after = next ? (before === "side" ? null : before) : "side";
    if (before === after) return;
    setCompactPanel(after);
    queueMicrotask(() => document.querySelector<HTMLElement>(after === "side" ? '[data-action="collapse-properties"], .panel-right button' : "[data-layout-focus='side-strip']")?.focus());
    return;
  }
  if (next === untrack(sidePanelPreference)) return;
  setSidePanelCollapsedRaw(next);
  queueMicrotask(() => document.querySelector<HTMLElement>(next ? "[data-layout-focus='side-strip']" : '[data-action="collapse-properties"], .panel-right button')?.focus());
}
export const toggleSidePanel = () => setSidePanelCollapsed(!sidePanelCollapsed());

export function resetDesignerLayout() {
  // raw setters: a layout reset from the menu does not move focus to a panel control
  setLeftTreeCollapsedRaw(false); setBottomDockCollapsed(false); setSidePanelCollapsedRaw(false);
  setCompactPanel(null);
  for (const key of ["fairbeam.panel-left-width", "fairbeam.panel-right-width", "fairbeam.ribbonMinimized", "fairbeam.ribbonTab"]) {
    try { localStorage.removeItem(key); } catch { /* Optional storage. */ }
  }
  window.dispatchEvent(new Event("fairbeam:reset-layout"));
}
