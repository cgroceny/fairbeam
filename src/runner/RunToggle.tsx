import { Show } from "solid-js";
import { LoaderCircle, Play } from "lucide-solid";
import { isTerminal } from "./api";
import { closeRunPanel, live, openRunPanel, runOpen, setRunOpen } from "./store";
import { setRunDialogOpen } from "./designRun";
import { runPythonFromStart } from "./startPython";
import { file as designFile } from "../designer/store";
import { appMode } from "../workspace";
import { t } from "../i18n";

/** Header button. In the designer it is the screen's one primary (copper) action: it opens the Run
 * dialog for the open design (the CST export beside it is secondary). On Start it is the secondary
 * "Run a Python model…" that opens the Run panel, the runner for Python model files. */
export default function RunToggle() {
  const busy = () => !!live.job && !isTerminal(live.job.status);
  const designing = () => appMode() === "design" && !!designFile();
  return (
    <button
      id="run-toggle"
      class="btn"
      classList={{ "btn-primary": designing(), "btn-ghost": !designing(), "rs-toggle-on": runOpen() && appMode() !== "home" }}
      aria-expanded={appMode() === "home" ? undefined : runOpen()}
      aria-controls={appMode() === "home" ? undefined : "run-panel"}
      onClick={() => {
        // with a design open, run what is on screen: the designer's Run saves and checks first
        // (the Run panel would submit the file as last saved, without the unsaved edits)
        // only hide the Run panel here: closeRunPanel() would restore the project from before the
        // preview and replace the design's preview under the dialog (closeDesign restores it later)
        if (appMode() === "design" && designFile()) { setRunOpen(false); setRunDialogOpen(true); return; }
        // Start has no Run panel of its own: open a Python model of the user in the results view (or say there is none)
        if (appMode() === "home") { void runPythonFromStart(); return; }
        if (runOpen()) closeRunPanel(); else openRunPanel();
      }}
      title={runOpen() ? t("runToggle.closeTitle") : t(designing() ? "runToggle.openTitle" : "runToggle.modelTitle")}
      aria-label={runOpen() ? t("runToggle.closeTitle") : t(designing() ? "runToggle.openAria" : "runToggle.modelAria")}
    >
      <Show when={busy()} fallback={<Play size={14} aria-hidden="true" />}>
        <LoaderCircle size={14} class="rs-spin" aria-hidden="true" />
      </Show>
      <span class="btn-label">{busy() ? t("runToggle.running") : t(designing() ? "runToggle.run" : "runToggle.runModel")}</span>
    </button>
  );
}
