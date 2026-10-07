// The run an export of the open design is made from (Export package, the Post-processing PDF report and Package).
// In Design mode the global bundle() is whatever the 3D view shows: the geometry preview most of the time (after an
// edit, after a visit to Examples), the shown run only while a run node is focused. The results of a design are its
// runs, so the exports take them from here: the run the design shows (the dock's result: the focused run, else the
// latest completed one, loaded by designRun.ts), else the newest run the project index lists for it (read here on
// demand). Never the geometry preview, never an Examples bundle.
import { createEffect, createRoot, createSignal, on } from "solid-js";
import type { Bundle } from "../types";
import { appMode } from "../workspace";
import { bundle } from "../state";
import { designResult } from "../runner/designRun";
import { file as designFile } from "./store";
import { designRuns, loadRunBundle } from "./runResults";

export interface DesignResultState {
  /** the run's bundle, null while none is known */
  bundle: Bundle | null;
  /** its result file */
  file: string | null;
  /** the newest listed run is being read */
  loading: boolean;
}

const [fallback, setFallback] = createSignal<{ file: string; bundle: Bundle } | null>(null);
const [reading, setReading] = createSignal<string | null>(null);

/** The newest run the index lists for the open design when the dock has none (a run of an earlier session, or one a
 * script started): read once per file, only in Design mode. */
createRoot(() => {
  createEffect(on([() => appMode(), () => designFile()?.design.model.id, () => designResult()?.file, () => designRuns()[0]?.file], ([mode, model, shown, newest]) => {
    if (fallback() && (fallback()!.bundle.model.id !== model || fallback()!.file !== newest)) setFallback(null);
    if (mode !== "design" || !model || shown || !newest || fallback()?.file === newest || reading() === newest) return;
    setReading(newest);
    loadRunBundle(newest).then((b) => {
      if (reading() === newest && b.model.id === designFile()?.design.model.id && b.results) setFallback({ file: newest, bundle: b });
    }, () => { /* the run cannot be read: the design has no exportable run */ }).finally(() => {
      if (reading() === newest) setReading(null);
    });
  }));
});

/** The design's run for exports in Design mode (see the top of this file); outside Design mode nothing. */
export function designResultState(): DesignResultState {
  const model = designFile()?.design.model.id;
  if (appMode() !== "design" || !model) return { bundle: null, file: null, loading: false };
  const shown = designResult();
  if (shown?.bundle.results && shown.bundle.model.id === model) return { bundle: shown.bundle, file: shown.file, loading: false };
  const f = fallback();
  if (f && f.bundle.model.id === model) return { bundle: f.bundle, file: f.file, loading: false };
  return { bundle: null, file: null, loading: reading() !== null };
}

/** The design's run for exports, or null. */
export const designResultBundle = (): Bundle | null => designResultState().bundle;

/** The bundle an export package is made from: in Design mode the design's run, else its geometry as the 3D view shows
 * it (the preview, never a bundle of another model); outside Design mode the shown bundle. */
export function exportBundle(): Bundle | null {
  if (appMode() !== "design") return bundle();
  const run = designResultBundle();
  if (run) return run;
  const b = bundle();
  const model = designFile()?.design.model.id;
  return b && model && b.model.id === model ? b : null;
}
