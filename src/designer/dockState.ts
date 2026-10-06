import { createSignal } from "solid-js";
import { setBottomDockCollapsed } from "./layoutState";

// Kept separate from run effects so focusPath can reveal parameters during store initialization.
// The result views themselves open as main-area tabs (MainArea.tsx); the dock lists the runs.
// "queue": the server's queued and running runs, whoever started them (src/runner/RunQueue.tsx)
export type DesignDockTab = "checks" | "parameters" | "run" | "runs" | "queue" | "log";
export const [parameterRanges, setParameterRanges] = createSignal(false);
const [designDockTab, setDesignDockTabRaw] = createSignal<DesignDockTab>("checks");
export { designDockTab };

/** Choosing a dock view is an explicit reveal, including when that view is already selected. */
export function setDesignDockTab(tab: DesignDockTab): void {
  setDesignDockTabRaw(tab);
  setBottomDockCollapsed(false);
}

/** Follow what is shown elsewhere (a result in the main area) without opening a collapsed dock. */
export function showDesignDockTab(tab: DesignDockTab): void {
  setDesignDockTabRaw(tab);
}

/** Shared entry point for the navigation tree and parameter field links. */
export function openParametersTab() {
  setDesignDockTab("parameters");
}
