// The Design workspace's main area as document tabs: the 3D view is the first tab and never
// closes; result views of the shown run open beside it (S-parameters, Smith, ...). Also the short run
// labels (A, B, C, ...) and the differing-parameter columns of the run table under a result. Pure
// functions without Solid, so scripts/check-results-tabs.mjs runs them as they are; mainTabsState.ts
// keeps one tab state per design and MainArea.tsx draws it.
import type { ResultView } from "./resultFocus";
import { t } from "../i18n/index.ts";

/** The result views that open as a main-area tab (the surface currents are drawn in the 3D view
 * itself, the log stays in the dock). */
export type MainResultView = Extract<ResultView, "sparams" | "impedance" | "vswr" | "smith" | "efficiency" | "pattern" | "table" | "fieldmap" | "summary">;
export type MainTabId = "3d" | MainResultView;

export const MAIN_RESULT_VIEWS: readonly MainResultView[] = ["sparams", "impedance", "vswr", "smith", "efficiency", "pattern", "table", "summary", "fieldmap"];

/** Tab names in the UI language (getters: read at render time, so the strip follows a language change). */
export const MAIN_TAB_LABELS: Record<MainTabId, string> = {
  get "3d"() { return t("results.tab.3d"); },
  get sparams() { return t("results.tab.sparams"); },
  get impedance() { return t("results.tab.impedance"); },
  get vswr() { return t("results.tab.vswr"); },
  get smith() { return t("results.tab.smith"); },
  get efficiency() { return t("results.tab.efficiency"); },
  get pattern() { return t("results.tab.pattern"); },
  get table() { return t("results.tab.table"); },
  get summary() { return t("results.tab.summary"); },
  get fieldmap() { return t("results.tab.fieldmap"); },
};

export interface MainTabs {
  /** the open result tabs, in the order they were opened (after the fixed 3D tab) */
  open: readonly MainResultView[];
  active: MainTabId;
}

export const ONLY_3D: MainTabs = { open: [], active: "3d" };

export const isMainResultView = (view: string): view is MainResultView => (MAIN_RESULT_VIEWS as readonly string[]).includes(view);

/** Every tab in strip order: 3D first. */
export const mainTabIds = (s: MainTabs): MainTabId[] => ["3d", ...s.open];

/** Open a result tab (appended when it is not open yet) and show it. */
export function openResultTab(s: MainTabs, view: MainResultView): MainTabs {
  return { open: s.open.includes(view) ? s.open : [...s.open, view], active: view };
}

/** Show an open tab; an id that is not open changes nothing. */
export function activateTab(s: MainTabs, id: MainTabId): MainTabs {
  return id === s.active || !mainTabIds(s).includes(id) ? s : { ...s, active: id };
}

/** Close a result tab; the 3D tab never closes. Closing the shown tab shows its right neighbour,
 * else its left one (the 3D tab at the latest), as document tabs do. */
export function closeTab(s: MainTabs, id: MainTabId): MainTabs {
  if (id === "3d" || !s.open.includes(id)) return s;
  const ids = mainTabIds(s);
  const at = ids.indexOf(id);
  const open = s.open.filter((v) => v !== id);
  if (s.active !== id) return { open, active: s.active };
  const rest = ids.filter((v) => v !== id);
  return { open, active: rest[Math.min(at, rest.length - 1)] };
}

/** The next (+1) or previous (-1) tab, wrapping at both ends (Ctrl+Tab / Ctrl+Shift+Tab). */
export function cycleTab(s: MainTabs, delta: number): MainTabs {
  const ids = mainTabIds(s);
  const at = Math.max(0, ids.indexOf(s.active));
  return { ...s, active: ids[(((at + delta) % ids.length) + ids.length) % ids.length] };
}

// ------------------------------------------------------------------ run labels and the run table

/** A, B, ..., Z, AA, AB, ... for 0, 1, ... (spreadsheet column names). */
export function runLetter(index: number): string {
  let n = Math.max(0, Math.floor(index)) + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** The short label of each run of a design, from its run list (newest first, as the navigation tree
 * lists them): the oldest run is A, so a run keeps its letter when newer runs are added. */
export function runLetters(filesNewestFirst: readonly string[]): Map<string, string> {
  const unique = [...new Set(filesNewestFirst)].reverse();
  return new Map(unique.map((file, i) => [file, runLetter(i)]));
}

export interface RunParams { params: readonly { key: string; value: unknown; unit?: string }[] }

/** The parameters whose value is not the same in every run (a parameter missing from a run counts
 * as a different value), in the order they first appear: one run-table column each. */
export function differingParams(runs: readonly RunParams[]): { key: string; unit: string }[] {
  if (runs.length < 2) return [];
  const keys = [...new Set(runs.flatMap((r) => r.params.map((p) => p.key)))];
  return keys.flatMap((key) => {
    const found = runs.map((r) => r.params.find((p) => p.key === key));
    if (new Set(found.map((p) => (p ? String(p.value) : "\u0000missing"))).size < 2) return [];
    return [{ key, unit: found.find((p) => p?.unit)?.unit ?? "" }];
  });
}

/** Whether a per-run value (the engine, say) tells the runs apart: worth a column of its own. */
export const differs = (values: readonly unknown[]) => values.length > 1 && new Set(values.map(String)).size > 1;

/** When each run was made, from the bundles' ISO timestamps: the time of day (HH:MM), with the date
 * (MM-DD) when the runs span several days and the seconds when two runs share a minute. */
export function madeLabels(created: readonly (string | undefined)[]): string[] {
  const parts = created.map((c) => /^\d{4}-(\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?/.exec(c ?? ""));
  const days = new Set(parts.map((m) => m?.[1]).filter(Boolean));
  const minutes = parts.map((m) => (m ? `${m[1]} ${m[2]}` : ""));
  return parts.map((m, i) => {
    if (!m) return "—";
    const clash = minutes.filter((x) => x === minutes[i]).length > 1;
    return `${days.size > 1 ? `${m[1]} ` : ""}${m[2]}${clash && m[3] ? m[3] : ""}`;
  });
}
