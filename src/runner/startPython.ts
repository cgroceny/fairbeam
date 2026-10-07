import { createSignal } from "solid-js";
import { models, openRunPanel } from "./store";
import { setAppMode } from "../workspace";
import { setPanelTab } from "../editor/store";

/** The Python models Start lists: the user's own first, then the bundled examples' (read-only: Run
 * asks to copy one or to run it as is, Open makes an editable Design copy). */
export const runnablePythonModels = () => {
  const python = models().filter((m) => m.kind !== "design" && !m.error);
  return [...python.filter((m) => !m.readonly), ...python.filter((m) => m.readonly)];
};

/** Start screen: the user asked to run a Python model (the header's "Run a Python model…"). Home
 * shows a line to choose one from its list, or explains that the workspace has none. */
export const [pythonHint, setPythonHint] = createSignal(false);

/** The model whose Run panel Start opened. Examples are a read-only viewer without a Run panel
 * (App.tsx), but a bundled Python model the user chose to run from Start gets one, as their own
 * models do (its Run asks to copy it or to run it as is). Cleared when the Examples screen is left. */
export const [startedPythonModel, setStartedPythonModel] = createSignal<string | null>(null);

/** Open the Run panel for a Python model from Start (results mode, Run tab). */
export async function runPythonModel(key: string) {
  setPythonHint(false);
  setStartedPythonModel(key);
  setAppMode("results");
  setPanelTab("run");
  await openRunPanel(key);
}

/** Header "Run a Python model…" on Start: never opens a model by itself (the first of several is an
 * arbitrary pick). It scrolls to Start's Python models and focuses the first one, with a line to
 * choose; without any model, the note that says so (and the "New Python model" button below it). */
export async function runPythonFromStart() {
  setPythonHint(true);
  requestAnimationFrame(() => {
    const first = document.querySelector<HTMLButtonElement>("#home-python-list [data-run-python-model]:not(:disabled)");
    const hint = document.getElementById("home-python-hint");
    (hint ?? first)?.scrollIntoView({ block: "center" });
    (first ?? hint)?.focus();
  });
}
