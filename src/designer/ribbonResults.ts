// Ribbon plots share the navigation tree's in-place result focus in Design mode: like the tree's result
// nodes they open as main-area tabs (the surface currents show in the 3D view).
import { designResult } from "../runner/designRun";
import { nearestIndex } from "../lib/rf";
import { bundle, farfieldIndex, setPackageOpen, source } from "../state";
import type { Bundle, FarField } from "../types";
import { appMode } from "../workspace";
import type { RunContent } from "./navModel";
import { focusResult, resultFocus, type ResultView } from "./resultFocus";
import { runContentOf } from "./runResults";
import { t } from "../i18n";

export const ribbonResult = () => resultFocus() ?? (designResult() ? { file: designResult()!.file, view: "sparams" as const } : null);

/** Export only the focused run already shown in 3D, never a preview or the previous run while loading. */
export const ribbonExportReady = () => {
  const result = resultFocus();
  return appMode() === "design" && !!result && source() === result.file && !!bundle()?.results && !bundle()?.preview;
};

export interface Availability { ok: boolean; reason: string }

/** Whether a run holds surface-current maps (#90): only a run with maps offers Currents, and the
 * reason says why not (null content = its bundle is still being read). */
export function currentsAvailability(content: RunContent | null): Availability {
  if (!content) return { ok: false, reason: t("ribbon.results.reading") };
  if (!content.currents.length) {
    return { ok: false, reason: t("ribbon.results.noCurrents") };
  }
  const n = content.currents.length;
  return { ok: true, reason: t("ribbon.results.showCurrents", { count: n }) };
}

/** The Currents action for the focused run (or the dock's latest run). */
export function ribbonCurrents(): Availability {
  const result = ribbonResult();
  if (!result) return { ok: false, reason: t("ribbon.results.selectResult") };
  return currentsAvailability(runContentOf(result.file));
}

/** Whether a run holds E/H field-plane maps (monitors.field_planes); null content = still reading. */
export function fieldPlanesAvailability(content: RunContent | null): Availability {
  if (!content) return { ok: false, reason: t("ribbon.results.reading") };
  const n = content.fieldPlanes?.length ?? 0;
  if (!n) return { ok: false, reason: t("ribbon.results.noFieldPlanes") };
  return { ok: true, reason: t("ribbon.results.showFieldPlane", { count: n }) };
}

/** The Field plane action for the focused run (or the dock's latest run). */
export function ribbonFieldPlanes(): Availability {
  const result = ribbonResult();
  if (!result) return { ok: false, reason: t("ribbon.results.selectResult") };
  return fieldPlanesAvailability(runContentOf(result.file));
}

/** The 3D pattern of the focused run: only a run with far fields offers it. */
export function ribbonPattern3d(): Availability {
  const result = ribbonResult();
  if (!result) return { ok: false, reason: t("ribbon.results.selectResult") };
  const content = runContentOf(result.file);
  if (!content) return { ok: false, reason: t("ribbon.results.reading") };
  if (!content.farfield.length) return { ok: false, reason: t("ribbon.results.noFarfield") };
  return { ok: true, reason: resultFocus()?.view === "pattern3d" ? t("ribbon.results.hidePattern3d") : t("ribbon.results.showPattern3d") };
}

/** The far field shown by the focused pattern view (the Pattern tab or the 3D pattern) of the shown
 * run, for the Post-processing tab's quantity picker; null for the other views. */
export function ribbonFarfield(): { bundle: Bundle; ff: FarField } | null {
  const focus = resultFocus();
  const run = designResult();
  if (!focus || (focus.view !== "pattern" && focus.view !== "pattern3d") || !run || run.file !== focus.file) return null;
  const ffs = run.bundle.results?.farfield ?? [];
  if (!ffs.length) return null;
  // the 3D pattern shows the selected entry (a multi-port run's port); the cuts the focused frequency
  const i = focus.view === "pattern3d" ? Math.min(farfieldIndex(), ffs.length - 1) : focus.f === undefined ? 0 : nearestIndex(ffs.map((x) => x.f), focus.f);
  return { bundle: run.bundle, ff: ffs[i] };
}

export function openRibbonResult(action: ResultView | "report" | "export") {
  if (appMode() !== "design") return;
  if (action === "report" || action === "export") {
    if (ribbonExportReady()) setPackageOpen(true);
    return;
  }
  // a run without maps has no current view: never focus it (the layer and dock tab would be empty)
  if (action === "currents" && !ribbonCurrents().ok) return;
  // a field plane: the focused one stays, else the run's first map
  if (action === "fieldplane") {
    if (!ribbonFieldPlanes().ok) return;
    const result = ribbonResult()!;
    if (result.view === "fieldplane" && result.map !== undefined) return;
    const first = runContentOf(result.file)!.fieldPlanes![0];
    return focusResult({ file: result.file, view: "fieldplane", f: first.f, map: first.map });
  }
  // the 2D map of a field plane: a main-area tab, for the focused map, else the run's first
  if (action === "fieldmap") {
    if (!ribbonFieldPlanes().ok) return;
    const result = ribbonResult()!;
    const maps = runContentOf(result.file)!.fieldPlanes!;
    const shown = maps.find((m) => m.map === result.map) ?? maps[0];
    return focusResult({ file: result.file, view: "fieldmap", f: shown.f, map: shown.map }, "main");
  }
  // the 3D pattern toggles: off goes back to the geometry
  if (action === "pattern3d") {
    if (!ribbonPattern3d().ok) return;
    if (resultFocus()?.view === "pattern3d") return focusResult(null);
    const result = ribbonResult()!;
    return focusResult({ ...result, view: "pattern3d", f: result.f ?? runContentOf(result.file)!.farfield[0] });
  }
  const result = ribbonResult();
  if (result) focusResult({ ...result, view: action }, "main");
}
