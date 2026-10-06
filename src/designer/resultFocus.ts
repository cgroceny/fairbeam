// The selected result of a design (#50): a run and one of its views. The navigation tree's result
// nodes (#52) and the dock set it; the ribbon's contextual Post-processing tab (#50 E) shows while it
// is set and acts on it. Anything outside Solid can listen to the "fairbeam:result-focus" window
// event (detail: the focus, or null). A result focused for the main area (the tree's result nodes,
// the ribbon, a main-area tab) opens there as a tab (MainArea.tsx); the dock shows the run table.
import { isTerminal } from "../runner/api";
import { designDockTab, designJob, setDesignDockTab } from "../runner/designRun";
import { showDesignDockTab } from "./dockState";
import { activateMainTab, openMainResult } from "./mainTabsState";
import { createResultFocusState } from "./resultSessionState";
export { IN_3D } from "./resultSessionState";

/** pattern: the directivity cuts (a main-area tab); pattern3d: the pattern drawn in the 3D view */
/** summary: the run card (headline numbers, matched bands, far field, efficiency; a table of runs when several are compared) */
/** fieldplane: an E/H field map on a cut plane, drawn in the 3D view (`map` picks it); fieldmap: the
 * same map as a 2D heat map in a main-area tab */
export type ResultView = "sparams" | "impedance" | "vswr" | "smith" | "efficiency" | "pattern" | "pattern3d" | "currents" | "fieldplane" | "fieldmap" | "table" | "summary" | "log";

export interface ResultFocus {
  /** the run's bundle file in the projects folder */
  file: string;
  view: ResultView;
  /** Hz, for the pattern and the surface currents */
  f?: number;
  /** the field-plane map (index into the bundle's field_planes) of the fieldplane and fieldmap views */
  map?: number;
  /** further bundle files when several runs are selected for comparison */
  compare?: string[];
}

/** What a focus does to the main area: "main" opens (or shows) the view's tab, "keep" leaves the
 * tabs as they are (a run picked while the 3D view is in front, a frequency chip). */
export type ResultTarget = "main" | "keep";
// The existing UI owns one instance. Additional instances have no global adapters by default.
const state = createResultFocusState({
  openMainResult,
  activateMainTab,
  dockTab: designDockTab,
  liveRun: () => { const job = designJob(); return !!job && !isTerminal(job.status); },
  setLogTab: () => setDesignDockTab("log"),
  showRunsTab: () => showDesignDockTab("runs"),
  announce: focus => window.dispatchEvent(new CustomEvent("fairbeam:result-focus", { detail: focus })),
});
export const resultFocus = state.resultFocus;
export const resultTarget = state.resultTarget;

/** Select a result (tree node, the Runs tab, a main-area tab, the Post-processing tab's buttons);
 * null goes back to the geometry. For the main area a view with a main-area tab opens there; the
 * 3D pattern and the surface currents bring the 3D tab to the front. The dock follows with its Runs
 * tab (the log with its own). Announces the change. */
export function focusResult(f: ResultFocus | null, where: ResultTarget = "keep"): void {
  state.focusResult(f, where);
}

/** Design and results stay apart: choosing a ribbon tab other than
 * Post-processing or View is geometry work, so a result drawn over the 3D view (the 3D pattern, surface
 * currents) goes and the design's own geometry comes back. Result tabs of the main area stay open;
 * they are separate documents. True when a result was cleared. */
export function leaveResultsFor(ribbonTab: string): boolean {
  return state.leaveResultsFor(ribbonTab);
}

/** The dock follows a shown result: after the focused run's bundle arrived (its Runs tab exists
 * now), or a result tab came to the front. */
export const followResultInDock = state.followResultInDock;
