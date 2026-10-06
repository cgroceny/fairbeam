// Instance-owned result selection and tabs. Only the UI wrappers supply global adapters.
import { createSignal, untrack } from "solid-js";
import { activateTab, closeTab, cycleTab, isMainResultView, ONLY_3D, openResultTab, type MainResultView, type MainTabId, type MainTabs } from "./resultTabs.ts";
import type { ResultFocus, ResultTarget, ResultView } from "./resultFocus.ts";

export const IN_3D = new Set<ResultView>(["pattern3d", "currents", "fieldplane"]);

export interface ResultFocusAdapters {
  openMainResult?: (view: MainResultView) => void;
  activateMainTab?: (id: MainTabId) => void;
  dockTab?: () => string;
  liveRun?: () => boolean;
  setLogTab?: () => void;
  showRunsTab?: () => void;
  announce?: (focus: ResultFocus | null) => void;
}

const copyFocus = (value: ResultFocus): ResultFocus => ({ ...value, ...(value.compare ? { compare: [...value.compare] } : {}) });
const ownFocus = (value: ResultFocus): ResultFocus => {
  const copy = copyFocus(value);
  if (copy.compare) Object.freeze(copy.compare);
  return Object.freeze(copy);
};

/** Creating another instance does not register effects, touch storage or route the visible UI. */
export function createResultFocusState(adapters: ResultFocusAdapters = {}) {
  let routes = { ...adapters };
  const [focus, setFocus] = createSignal<ResultFocus | null>(null, {
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  let target: ResultTarget = "keep", disposed = false;
  const followInDock = (view: ResultView): void => {
    if (disposed) return;
    if (view === "log") { routes.setLogTab?.(); return; }
    if (routes.dockTab?.() === "run" && routes.liveRun?.()) return;
    routes.showRunsTab?.();
  };
  const focusResult = (value: ResultFocus | null, where: ResultTarget = "keep"): boolean => {
    if (disposed) return false;
    const next = value ? ownFocus(value) : null;
    target = next && where === "main" && isMainResultView(next.view) ? "main" : "keep";
    setFocus(next);
    if (next && target === "main" && isMainResultView(next.view)) routes.openMainResult?.(next.view);
    if (next && IN_3D.has(next.view)) routes.activateMainTab?.("3d");
    if (next) followInDock(next.view);
    // Event consumers get their own copy; mutating it cannot change the stored selection.
    routes.announce?.(next ? copyFocus(next) : null);
    return true;
  };
  return {
    resultFocus: focus,
    resultTarget: (): ResultTarget => target,
    focusResult,
    followResultInDock: followInDock,
    leaveResultsFor(ribbonTab: string): boolean {
      const current = untrack(focus);
      if (disposed || ribbonTab === "post" || ribbonTab === "view" || !current || !IN_3D.has(current.view)) return false;
      return focusResult(null);
    },
    dispose(): void { disposed = true; routes = {}; target = "keep"; setFocus(null); },
  };
}

const ownTabs = (tabs: MainTabs): MainTabs => Object.freeze({ open: Object.freeze([...tabs.open]), active: tabs.active });

/** Tab transitions use the same model as the default UI, with private open/active state. */
export function createMainTabsState(initial: MainTabs = ONLY_3D, adapters: { focusActive?: () => void } = {}) {
  let focusActive = adapters.focusActive;
  const [tabs, setTabs] = createSignal<MainTabs>(ownTabs(initial));
  let disposed = false;
  const update = (next: (current: MainTabs) => MainTabs): boolean => {
    if (disposed) return false;
    const current = untrack(tabs), value = next(current);
    if (value.active === current.active && value.open.join() === current.open.join()) return false;
    setTabs(ownTabs(value));
    return true;
  };
  return {
    mainTabs: tabs,
    activeMainResult: (): MainResultView | null => tabs().active === "3d" ? null : tabs().active as MainResultView,
    openMainResult: (view: MainResultView) => update(current => openResultTab(current, view)),
    activateMainTab: (id: MainTabId) => update(current => activateTab(current, id)),
    closeMainTab: (id: MainTabId) => update(current => closeTab(current, id)),
    cycleMainTabs: (delta: number) => update(current => cycleTab(current, delta)),
    focusActiveMainTab(): void { if (!disposed) focusActive?.(); },
    dispose(): void { disposed = true; focusActive = undefined; setTabs(ownTabs(ONLY_3D)); },
  };
}
