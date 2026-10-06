import { createSignal } from "solid-js";
import { models, openRunPanel } from "./store";
import { setAppMode } from "../workspace";
import { setPanelTab } from "../editor/store";

/** Bundled models are read-only and have no Run panel, so only the user's own Python models can be
 * run from Start. */
export const runnablePythonModels = () => models().filter((m) => m.kind !== "design" && !m.error && !m.readonly);

/** Start screen: the user asked to run a Python model but has none of their own yet. Home shows
 * an explanation (and the "New Python model" button) instead of the click doing nothing. */
export const [pythonHint, setPythonHint] = createSignal(false);

/** Open the Run panel for a Python model of the user's (results mode, Run tab). */
export async function runPythonModel(key: string) {
  setPythonHint(false);
  setAppMode("results");
  setPanelTab("run");
  await openRunPanel(key);
}

/** Header "Run a Python model…" on Start: never opens a model by itself (the first of several is an
 * arbitrary pick, e.g. a copied example). Start shows its Python models list with a note to choose
 * one, or explains that there is none. */
export async function runPythonFromStart() {
  setPythonHint(true);
  requestAnimationFrame(() => {
    const el = document.getElementById("home-python-hint");
    el?.scrollIntoView({ block: "center" });
    el?.focus();
  });
}
